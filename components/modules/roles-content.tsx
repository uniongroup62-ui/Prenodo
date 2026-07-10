"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP roles page (app/pages/roles.php): role list + the
// permissions tree form for the selected manageable role (Staff / Altro). Fed
// by the existing DB-backed /api/manage/permissions route. The inheritance and
// module-root checkbox behaviour mirrors public/assets/js/pages/roles.js.

type PermissionDefinition = {
  perm: string;
  label: string;
  groupName: string;
  sortOrder: number;
  parent?: string;
  parents?: string[];
  displayParent?: string;
  assignable?: boolean;
};

type PermGroup = {
  groupName: string;
  definitions: PermissionDefinition[];
};

type RolePermissions = {
  definitions: PermissionDefinition[];
  groups: PermGroup[];
  manageableRoles: Record<string, string>;
  selectedRole: string;
  assignments: Record<string, string[]>;
  selectedPerms: string[];
  validationError: string | null;
};

// Module-access rules (mirror lib/role-permissions.ts moduleAccessRules()).
const MODULE_ACCESS_RULES: Record<string, { label: string; children: string[] }> = {
  "packages.access": {
    label: "Pacchetti",
    children: ["packages.clients", "packages.catalog", "packages.settings"],
  },
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Display tree node, derived from a permission definition (mirror PHP renderer).
type TreeNode = {
  def: PermissionDefinition;
  level: number;
  parentPerms: string[]; // data-parent-perms
  isModuleRoot: boolean; // data-module-root-input="1"
  moduleChildren: string[]; // data-module-children
  moduleAccess: string; // data-module-access
};

function moduleAccessForChild(perm: string): string {
  for (const [accessPerm, rule] of Object.entries(MODULE_ACCESS_RULES)) {
    if (rule.children.includes(perm)) return accessPerm;
  }
  return "";
}

// Port fedele di RolePermissions::groupedTree + $renderPermNode (roles.php):
// l'albero include ANCHE le radici non assegnabili (es. 'packages.manage',
// il padre legacy di tutto il modulo Pacchetti) che non vengono renderizzate
// ma fanno da contenitore — i figli restano al loro livello ($childLevel =
// $assignable ? $level+1 : $level). Un tree entra solo se ha almeno un nodo
// assegnabile (nodeHasAssignable).
function buildGroupTrees(group: PermGroup): TreeNode[][] {
  const byPerm = new Map<string, PermissionDefinition>();
  for (const def of group.definitions) byPerm.set(def.perm, def);

  // display_parent esplicito (anche "") vince; poi parent; poi il primo dei
  // parents presente nel catalogo (se il primo è un alias assente e nessun
  // successivo è presente, resta l'alias → il nodo è radice).
  function displayParentOf(def: PermissionDefinition): string {
    if (typeof def.displayParent === "string") return def.displayParent;
    let parent = def.parent ?? "";
    if (!parent && def.parents && def.parents.length > 0) {
      for (const candidate of def.parents) {
        if (candidate && byPerm.has(candidate)) {
          parent = candidate;
          break;
        }
        if (!parent) parent = candidate;
      }
    }
    return parent;
  }

  const childrenByParent = new Map<string, PermissionDefinition[]>();
  const roots: PermissionDefinition[] = [];
  for (const def of group.definitions) {
    const dp = displayParentOf(def);
    if (dp && byPerm.has(dp)) {
      const arr = childrenByParent.get(dp) ?? [];
      arr.push(def);
      childrenByParent.set(dp, arr);
    } else {
      roots.push(def);
    }
  }

  const bySortThenLabel = (a: PermissionDefinition, b: PermissionDefinition) =>
    a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });

  function nodeFor(def: PermissionDefinition, level: number): TreeNode {
    const moduleRule = MODULE_ACCESS_RULES[def.perm];
    return {
      def,
      level,
      parentPerms: Array.from(new Set([def.parent, ...(def.parents ?? [])].filter((v): v is string => Boolean(v)))),
      isModuleRoot: Boolean(moduleRule),
      moduleChildren: moduleRule ? moduleRule.children : [],
      moduleAccess: moduleAccessForChild(def.perm),
    };
  }

  const trees: TreeNode[][] = [];
  for (const root of roots.sort(bySortThenLabel)) {
    const nodes: TreeNode[] = [];
    const visit = (def: PermissionDefinition, level: number) => {
      const assignable = def.assignable !== false;
      if (assignable) nodes.push(nodeFor(def, level));
      const childLevel = assignable ? level + 1 : level;
      for (const kid of (childrenByParent.get(def.perm) ?? []).sort(bySortThenLabel)) {
        visit(kid, childLevel);
      }
    };
    visit(root, 0);
    if (nodes.length > 0) trees.push(nodes);
  }
  return trees;
}

type Flash = { text: string; type: "success" | "danger" };

export function RolesContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string; err?: string; role?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const initialRole = String(initialQuery?.role ?? "staff").trim().toLowerCase() === "altro" ? "altro" : "staff";

  const [data, setData] = useState<RolePermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRole, setActiveRole] = useState<string>(initialRole);
  const [saving, setSaving] = useState(false);
  // Auth::requirePerm legacy: 403 → pagina 'Accesso negato' (card nel chrome).
  const [accessDenied, setAccessDenied] = useState(false);
  // Flash legacy (View::alert msg success / err danger PRIMA del page header).
  const [flash, setFlash] = useState<Flash | null>(() => {
    if (initialQuery?.err) return { text: String(initialQuery.err), type: "danger" };
    if (initialQuery?.msg) return { text: String(initialQuery.msg), type: "success" };
    return null;
  });

  // directSelected[perm] = user-chosen state (mirrors data-directSelected in roles.js).
  const [directSelected, setDirectSelected] = useState<Record<string, boolean>>({});

  const showFlash = useCallback((next: Flash | null) => {
    setFlash(next);
    if (next && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(
    (role: string) => {
      // `loading` parte true e viene azzerato nel .finally; i chiamanti da
      // event handler (selectRole) lo riattivano prima di chiamare load.
      fetch(`/api/manage/permissions?slug=${encodeURIComponent(slug)}&role=${encodeURIComponent(role)}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => {
          if (r.status === 403) setAccessDenied(true);
          return r.json();
        })
        .then((j) => {
          const rp: RolePermissions | null = j?.rolePermissions ?? null;
          setData(rp);
          if (rp) {
            setActiveRole(rp.selectedRole ?? role);
            const initial: Record<string, boolean> = {};
            for (const perm of rp.selectedPerms ?? []) initial[perm] = true;
            setDirectSelected(initial);
          }
        })
        .catch(() => setData(null))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    load(initialRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Cambio ruolo = navigazione legacy (?role=): URL aggiornato e flash azzerato.
  function selectRole(role: string) {
    setActiveRole(role);
    setFlash(null);
    setLoading(true);
    if (typeof window !== "undefined") window.history.replaceState(null, "", href(`&role=${encodeURIComponent(role)}`));
    load(role);
  }

  // ---- Inheritance / module resolution (mirror roles.js) ----
  const allDefs = data?.definitions ?? [];
  const defByPerm = useMemo(() => {
    const m = new Map<string, PermissionDefinition>();
    for (const d of allDefs) m.set(d.perm, d);
    return m;
  }, [allDefs]);

  // childrenByParent built from each def's parentPerms (data-parent-perms).
  const childrenByParent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const def of allDefs) {
      const parents = Array.from(new Set([def.parent, ...(def.parents ?? [])].filter((v): v is string => Boolean(v))));
      for (const parentPerm of parents) {
        const arr = m.get(parentPerm) ?? [];
        arr.push(def.perm);
        m.set(parentPerm, arr);
      }
    }
    return m;
  }, [allDefs]);

  // Resolve granted (checked) + inherited (checked & disabled) sets.
  const { checkedPerms, inheritedPerms } = useMemo(() => {
    const granted = new Set<string>();
    const moduleRootPerms = new Set(Object.keys(MODULE_ACCESS_RULES));

    for (const def of allDefs) {
      if (moduleRootPerms.has(def.perm)) continue;
      if (directSelected[def.perm]) granted.add(def.perm);
    }

    const inherited = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const parentPerm of Array.from(granted)) {
        for (const childPerm of childrenByParent.get(parentPerm) ?? []) {
          if (moduleRootPerms.has(childPerm)) continue;
          inherited.add(childPerm);
          if (!granted.has(childPerm)) {
            granted.add(childPerm);
            changed = true;
          }
        }
      }
    }

    // Module roots: checked when any child is selected (disabled control).
    for (const [accessPerm, rule] of Object.entries(MODULE_ACCESS_RULES)) {
      const anyChild = rule.children.some((c) => granted.has(c) || directSelected[c]);
      if (anyChild) granted.add(accessPerm);
      else granted.delete(accessPerm);
    }

    return { checkedPerms: granted, inheritedPerms: inherited };
  }, [allDefs, directSelected, childrenByParent]);

  function toggle(perm: string, isModuleRoot: boolean) {
    if (isModuleRoot) return; // module root is read-only (disabled)
    if (inheritedPerms.has(perm)) return; // inherited rows are disabled
    setDirectSelected((prev) => ({ ...prev, [perm]: !prev[perm] }));
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`roles${suffix}`.replace("&", "?")}`;
  }

  const roleLabel = data?.manageableRoles?.[activeRole] ?? (activeRole === "altro" ? "Altro" : "Staff");
  const roleEntries = Object.entries(data?.manageableRoles ?? { staff: "Staff", altro: "Altro" });
  const groups = data?.groups ?? [];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    // Come il form legacy: gli input ereditati/modulo sono disabled e non
    // vengono postati; qui inviamo le selezioni dirette (il server normalizza).
    const perms = Object.keys(directSelected).filter((p) => directSelected[p]);
    try {
      const res = await fetch(`/api/manage/permissions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, action: "save_role_perms", role: activeRole, perms }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        // Flash err del redirect legacy (validazione modulo / errore DB).
        showFlash({ text: String(j?.error ?? "Impossibile aggiornare i permessi: verifica schema DB e riprova."), type: "danger" });
        return;
      }
      showFlash({ text: `Permessi ${roleLabel} aggiornati`, type: "success" });
      load(activeRole);
    } catch {
      showFlash({ text: "Impossibile aggiornare i permessi: verifica schema DB e riprova.", type: "danger" });
    } finally {
      setSaving(false);
    }
  }

  // Port della pagina 403 di Auth::requirePerm (Auth.php 494-505): solo la
  // card 'Accesso negato' nel chrome, senza page header Ruoli.
  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Non hai i permessi per accedere a questa sezione.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/roles.css" />

      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Ruoli</h1>
          <div className="bs-page-subtitle">Configura i permessi disponibili per i ruoli operativi.</div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-4">
          <div className="card p-4">
            <div className="small text-muted">
              <strong>Admin</strong> ha sempre accesso completo. Qui puoi decidere cosa possono fare <strong>Staff</strong> e{" "}
              <strong>Altro</strong>. La gestione dei ruoli e l&apos;assegnazione del ruolo Admin restano riservate ad Admin.
            </div>

            <hr className="my-3" />

            <div className="mb-2 fw-semibold">Ruoli disponibili</div>
            <ul className="mb-0">
              <li>
                <strong>Admin</strong>
              </li>
              {roleEntries.map(([key, label]) => (
                <li key={key}>
                  <strong>{label}</strong>
                </li>
              ))}
            </ul>

            <hr className="my-3" />
            <div className="small text-muted mb-2">Configura permessi</div>
            <div className="d-flex flex-wrap gap-2">
              {roleEntries.map(([key, label]) => (
                <a
                  key={key}
                  className={`btn btn-sm ${key === activeRole ? "btn-primary" : "btn-outline-primary"}`}
                  href={href(`&role=${encodeURIComponent(key)}`)}
                  onClick={(e) => {
                    e.preventDefault();
                    selectRole(key);
                  }}
                >
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="col-lg-8">
          <div className="card p-4">
            <div className="d-flex align-items-start justify-content-between gap-3">
              <div>
                <div className="fw-semibold">Permessi ruolo: {roleLabel}</div>
                <div className="small text-muted">
                  Nei moduli composti seleziona le funzioni: l&apos;accesso al modulo viene attivato automaticamente. Le
                  modifiche vengono registrate nello storico tecnico.
                </div>
              </div>
            </div>

            <form method="post" className="mt-3" onSubmit={onSubmit}>
              <input type="hidden" name="action" value="save_role_perms" />
              <input type="hidden" name="role" value={activeRole} />

              <div className="roles-perm-sections">
                {loading && groups.length === 0 ? (
                  <div className="text-muted small">Caricamento…</div>
                ) : (
                  groups.map((group) => {
                    const trees = buildGroupTrees(group);
                    if (trees.length === 0) return null;
                    return (
                      <section className="roles-perm-section" key={group.groupName}>
                        <h2 className="roles-perm-section-title">{group.groupName}</h2>
                        <div className="roles-perm-grid">
                          {trees.map((nodes, ti) => (
                            <div className="roles-perm-tree" key={`${group.groupName}-${ti}`}>
                              {nodes.map((node) => {
                                const def = node.def;
                                const isChecked = checkedPerms.has(def.perm);
                                const isInherited = inheritedPerms.has(def.perm);
                                const disabled = node.isModuleRoot || isInherited;
                                const labelText =
                                  defByPerm.get(def.perm)?.label ?? def.label ?? "—";
                                const childClass = node.level > 0 ? " role-perm-node-child" : "";
                                const moduleRootClass = node.isModuleRoot ? " role-module-root" : "";
                                return (
                                  <label
                                    key={def.perm}
                                    className={`role-perm-node d-flex align-items-center justify-content-between border rounded-3 p-2${childClass}${moduleRootClass} role-perm-level-${node.level}`}
                                    data-role-perm-node=""
                                    data-perm={def.perm}
                                    {...(node.isModuleRoot ? { "data-module-root": def.perm } : {})}
                                  >
                                    <span className="role-perm-label">
                                      <span className="fw-semibold">
                                        {node.level > 0 ? <span className="text-muted me-1">↳</span> : null}
                                        {labelText}
                                      </span>
                                      {node.isModuleRoot ? (
                                        <span className="badge text-bg-primary-subtle text-primary border ms-1">Modulo</span>
                                      ) : null}
                                      <span
                                        className={`badge text-bg-light border ms-1${isInherited ? "" : " d-none"}`}
                                        data-inherited-badge=""
                                      >
                                        Ereditato
                                      </span>
                                    </span>
                                    <input
                                      className="form-check-input"
                                      type="checkbox"
                                      name="perms[]"
                                      value={def.perm}
                                      data-role-perm-input=""
                                      data-perm={def.perm}
                                      data-parent-perms={node.parentPerms.join(",")}
                                      data-auto-parent-perms=""
                                      data-direct={directSelected[def.perm] ? "1" : "0"}
                                      data-inherited={isInherited ? "1" : "0"}
                                      {...(node.isModuleRoot
                                        ? {
                                            "data-module-root-input": "1",
                                            "data-module-children": node.moduleChildren.join(","),
                                          }
                                        : {})}
                                      {...(node.moduleAccess ? { "data-module-access": node.moduleAccess } : {})}
                                      checked={isChecked}
                                      disabled={disabled}
                                      onChange={() => toggle(def.perm, node.isModuleRoot)}
                                    />
                                  </label>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })
                )}
              </div>

              <hr className="my-3" />
              <div className="d-flex justify-content-end">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva permessi {roleLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

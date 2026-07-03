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

function splitPerms(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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

// Build, per group, the ordered list of trees -> nodes, replicating the PHP
// page layout: roots (level 0) followed by their display children (level 1+).
function buildGroupTrees(group: PermGroup): TreeNode[][] {
  const byPerm = new Map<string, PermissionDefinition>();
  for (const def of group.definitions) byPerm.set(def.perm, def);

  // Determine display parent for each def.
  function displayParentOf(def: PermissionDefinition): string {
    if (typeof def.displayParent === "string") return def.displayParent;
    if (def.parent) return def.parent;
    if (def.parents && def.parents.length > 0) {
      // First parent that is itself a definition in this group.
      for (const p of def.parents) {
        if (byPerm.has(p)) return p;
      }
    }
    return "";
  }

  // Roots are defs whose display parent is not present in this group.
  const childrenByParent = new Map<string, PermissionDefinition[]>();
  const roots: PermissionDefinition[] = [];
  for (const def of group.definitions) {
    if (def.assignable === false) continue;
    const dp = displayParentOf(def);
    if (dp && byPerm.has(dp)) {
      const arr = childrenByParent.get(dp) ?? [];
      arr.push(def);
      childrenByParent.set(dp, arr);
    } else {
      roots.push(def);
    }
  }

  function levelDepth(def: PermissionDefinition, depth: number): number {
    const dp = displayParentOf(def);
    if (dp && byPerm.has(dp)) {
      const parentDef = byPerm.get(dp);
      if (parentDef && parentDef !== def) {
        return levelDepth(parentDef, depth + 1);
      }
    }
    return depth;
  }

  function nodeFor(def: PermissionDefinition): TreeNode {
    const moduleRule = MODULE_ACCESS_RULES[def.perm];
    return {
      def,
      level: levelDepth(def, 0),
      parentPerms: Array.from(new Set([def.parent, ...(def.parents ?? [])].filter((v): v is string => Boolean(v)))),
      isModuleRoot: Boolean(moduleRule),
      moduleChildren: moduleRule ? moduleRule.children : [],
      moduleAccess: moduleAccessForChild(def.perm),
    };
  }

  const trees: TreeNode[][] = [];
  for (const root of roots.sort((a, b) => a.sortOrder - b.sortOrder)) {
    const nodes: TreeNode[] = [nodeFor(root)];
    const stack = [...(childrenByParent.get(root.perm) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    // Breadth-first by display parent, appended in sort order, depth-first per branch.
    const visit = (parentPerm: string) => {
      const kids = (childrenByParent.get(parentPerm) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const kid of kids) {
        nodes.push(nodeFor(kid));
        visit(kid.perm);
      }
    };
    void stack; // ordering handled by visit
    visit(root.perm);
    trees.push(nodes);
  }
  return trees;
}

export function RolesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [data, setData] = useState<RolePermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRole, setActiveRole] = useState<string>("staff");

  // directSelected[perm] = user-chosen state (mirrors data-directSelected in roles.js).
  const [directSelected, setDirectSelected] = useState<Record<string, boolean>>({});

  const load = useCallback(
    (role: string) => {
      setLoading(true);
      fetch(`/api/manage/permissions?slug=${encodeURIComponent(slug)}&role=${encodeURIComponent(role)}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
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
    load("staff");
  }, [load]);

  function selectRole(role: string) {
    setActiveRole(role);
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const perms = Object.keys(directSelected).filter((p) => directSelected[p]);
    fetch(`/api/manage/permissions?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify({ slug, action: "save_role_perms", role: activeRole, perms }),
    })
      .then((r) => r.json())
      .then(() => load(activeRole))
      .catch(() => {});
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/roles.css" />

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

            {data?.validationError ? (
              <div className="alert alert-danger mt-3 mb-0" role="alert">
                {data.validationError}
              </div>
            ) : null}

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
                <button className="btn btn-primary" type="submit">
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

export type PermissionDefinition = {
  perm: string;
  label: string;
  groupName: string;
  sortOrder: number;
  parent?: string;
  parents?: string[];
  displayParent?: string;
  assignable?: boolean;
};

export type ModuleAccessRule = {
  label: string;
  children: string[];
  legacyFull: string[];
  requireChild: boolean;
};

export const permissionDefinitions: PermissionDefinition[] = [
  { perm: "dashboard.view", label: "Dashboard", groupName: "Generale", sortOrder: 10 },
  { perm: "calendar.view", label: "Calendario", groupName: "Generale", sortOrder: 20 },
  { perm: "notifications.view", label: "Notifiche", groupName: "Generale", sortOrder: 30 },

  { perm: "appointments.manage", label: "Appuntamenti", groupName: "Appuntamenti", sortOrder: 10 },
  { perm: "appointments.plan", label: "Pianifica", groupName: "Appuntamenti", sortOrder: 20, displayParent: "appointments.manage" },
  { perm: "appointments.quick_booking", label: "Prenotazione rapida", groupName: "Appuntamenti", sortOrder: 30, displayParent: "appointments.manage" },

  { perm: "pos.manage", label: "Pagamenti", groupName: "Pagamenti", sortOrder: 10 },
  { perm: "pos.movements", label: "Movimenti", groupName: "Pagamenti", sortOrder: 20, parents: ["pos.manage", "pos.history"] },
  { perm: "pos.prepaids", label: "Prepagati", groupName: "Pagamenti", sortOrder: 30, parents: ["pos.manage", "prepaids.manage"] },
  { perm: "pos.preorders", label: "Preordini", groupName: "Pagamenti", sortOrder: 40, parents: ["pos.manage", "preorders.manage"] },
  { perm: "installments.manage", label: "Gestione Rate", groupName: "Pagamenti", sortOrder: 50 },
  { perm: "pos.settings", label: "Impostazioni", groupName: "Pagamenti", sortOrder: 60, displayParent: "pos.manage" },

  { perm: "costs.manage", label: "Scadenziario e Costi", groupName: "Scadenziario e Costi", sortOrder: 10 },
  { perm: "costs.items", label: "Costi", groupName: "Scadenziario e Costi", sortOrder: 20, parents: ["costs.manage", "costs.costs", "cost_items.manage"] },
  { perm: "costs.categories", label: "Categorie", groupName: "Scadenziario e Costi", sortOrder: 30, parents: ["costs.manage", "cost_categories.manage"] },

  { perm: "products.manage", label: "Magazzino", groupName: "Magazzino", sortOrder: 10 },
  { perm: "product_categories.manage", label: "Categorie prodotti", groupName: "Magazzino", sortOrder: 20, parents: ["products.manage", "product.categories.manage"] },
  { perm: "stock_moves.manage", label: "Carico / Scarico", groupName: "Magazzino", sortOrder: 30, parents: ["products.manage", "products.stock", "stock.manage"] },
  { perm: "coupons.manage", label: "Buoni", groupName: "Magazzino", sortOrder: 50 },

  { perm: "suppliers.manage", label: "Fornitori", groupName: "Anagrafiche", sortOrder: 10 },

  { perm: "clients.manage", label: "Clienti", groupName: "Clienti", sortOrder: 10 },
  { perm: "client_sheets.manage", label: "Schede cliente", groupName: "Clienti", sortOrder: 20, parents: ["clients.manage", "clients.sheets"] },
  { perm: "client_consents.manage", label: "Consensi cliente", groupName: "Clienti", sortOrder: 30, parents: ["clients.manage", "clients.consents"] },

  { perm: "packages.access", label: "Pacchetti", groupName: "Pacchetti", sortOrder: 10, parents: ["packages.manage"] },
  { perm: "packages.manage", label: "Pacchetti completo legacy", groupName: "Pacchetti", sortOrder: 11, assignable: false },
  { perm: "packages.clients", label: "Clienti", groupName: "Pacchetti", sortOrder: 20, parents: ["packages.manage"], displayParent: "packages.access" },
  { perm: "packages.catalog", label: "Catalogo", groupName: "Pacchetti", sortOrder: 30, parents: ["packages.manage"], displayParent: "packages.access" },
  { perm: "packages.settings", label: "Impostazioni", groupName: "Pacchetti", sortOrder: 40, parents: ["packages.manage"], displayParent: "packages.access" },

  { perm: "quotes.manage", label: "Preventivi", groupName: "Preventivi", sortOrder: 10 },
  { perm: "quotes.settings", label: "Impostazioni", groupName: "Preventivi", sortOrder: 20, displayParent: "quotes.manage" },

  { perm: "fidelity.manage", label: "Fidelity", groupName: "Fidelizzazione", sortOrder: 10 },
  { perm: "fidelity.membership", label: "Adesione", groupName: "Fidelizzazione", sortOrder: 20, parents: ["fidelity.manage"] },
  { perm: "fidelity.recharges", label: "Ricariche", groupName: "Fidelizzazione", sortOrder: 40, parents: ["fidelity.manage", "recharges.manage"] },
  { perm: "fidelity.wallet", label: "Portafoglio", groupName: "Fidelizzazione", sortOrder: 50, parents: ["fidelity.manage", "wallet.manage"] },
  { perm: "credit_movements.manage", label: "Movimenti credito", groupName: "Fidelizzazione", sortOrder: 60, parents: ["fidelity.wallet", "fidelity.manage"] },
  { perm: "promotions.manage", label: "Promozioni", groupName: "Fidelizzazione", sortOrder: 70, parents: ["fidelity.manage", "fidelity.promotions"] },
  { perm: "fidelity.points", label: "Punti", groupName: "Fidelizzazione", sortOrder: 80, parents: ["fidelity.manage", "fidelity_points.manage"] },
  { perm: "fidelity.levels", label: "Livelli Card", groupName: "Fidelizzazione", sortOrder: 90, parents: ["fidelity.points", "fidelity.manage"] },
  { perm: "gifts.manage", label: "Omaggi", groupName: "Fidelizzazione", sortOrder: 100, parents: ["fidelity.manage"] },
  { perm: "giftbox.manage", label: "GiftBox", groupName: "Fidelizzazione", sortOrder: 110, parents: ["fidelity.manage", "fidelity.giftbox"] },
  { perm: "giftbox.settings", label: "Impostazioni", groupName: "Fidelizzazione", sortOrder: 120, parents: ["fidelity.giftbox.settings"], displayParent: "giftbox.manage" },
  { perm: "giftcard.manage", label: "GiftCard", groupName: "Fidelizzazione", sortOrder: 130, parents: ["fidelity.manage", "fidelity.giftcard"] },
  { perm: "giftcard.settings", label: "Impostazioni", groupName: "Fidelizzazione", sortOrder: 140, parents: ["fidelity.giftcard.settings"], displayParent: "giftcard.manage" },

  { perm: "resources.manage", label: "Risorse", groupName: "Risorse", sortOrder: 10, parents: ["services.resources"], displayParent: "" },
  { perm: "services.manage", label: "Servizi", groupName: "Risorse", sortOrder: 20 },
  { perm: "service_categories.manage", label: "Categorie", groupName: "Risorse", sortOrder: 30, parents: ["services.manage", "services.categories", "service.categories.manage"] },
  { perm: "service_recommendations.manage", label: "Consigliati", groupName: "Risorse", sortOrder: 40, parents: ["services.manage", "services.recommendations", "service.recommendations.manage", "suggested_services.manage"] },
  { perm: "cabins.manage", label: "Cabine", groupName: "Risorse", sortOrder: 50, parents: ["services.cabins"], displayParent: "" },
  { perm: "staff.manage", label: "Operatori", groupName: "Risorse", sortOrder: 60 },
  { perm: "staff_availability.manage", label: "Disponibilità", groupName: "Risorse", sortOrder: 70, parents: ["staff.manage", "staff.availability"] },
  { perm: "hours.manage", label: "Orari", groupName: "Risorse", sortOrder: 80 },

  { perm: "settings.manage", label: "Impostazioni", groupName: "Impostazioni", sortOrder: 10 },
  { perm: "settings.general", label: "Profilo attività", groupName: "Impostazioni", sortOrder: 20, parent: "settings.manage" },
  { perm: "settings.location", label: "Sede", groupName: "Impostazioni", sortOrder: 30, parents: ["settings.manage", "business.manage", "settings.business"] },
  { perm: "consent_modules.manage", label: "Moduli consenso", groupName: "Impostazioni", sortOrder: 40, parents: ["settings.manage", "settings.consent_modules", "consents.manage"] },
  { perm: "accessibility.manage", label: "Accessibilità", groupName: "Impostazioni", sortOrder: 50, parent: "settings.manage", assignable: false },
  { perm: "automation.manage", label: "Automazione", groupName: "Impostazioni", sortOrder: 60, parent: "settings.manage" },
  { perm: "reports.view", label: "Report", groupName: "Impostazioni", sortOrder: 70, parent: "settings.manage" },
  { perm: "booking.manage", label: "Booking", groupName: "Impostazioni", sortOrder: 80, parent: "settings.manage" },
  { perm: "roles.manage", label: "Ruoli", groupName: "Impostazioni", sortOrder: 90, assignable: false },

  { perm: "commissions.manage", label: "Commissioni", groupName: "Amministrazione", sortOrder: 10 },
];

export const manageableRoles: Record<string, string> = {
  staff: "Staff",
  altro: "Altro",
};

export const featurePermissionMap: Record<string, string> = {
  dashboard: "dashboard.view",
  calendar: "calendar.view",
  notifications: "notifications.view",
  appointments: "appointments.manage",
  appointments_plan: "appointments.plan",
  booking: "booking.manage",
  pos: "pos.manage",
  pos_history: "pos.movements",
  pos_prepaids: "pos.prepaids",
  pos_preorders: "pos.preorders",
  pos_settings: "pos.settings",
  installments_manage: "installments.manage",
  commissions: "commissions.manage",
  costs: "costs.manage",
  cost_categories: "costs.categories",
  quotes: "quotes.manage",
  quote_settings: "quotes.settings",
  reports: "reports.view",
  products: "products.manage",
  product_categories: "product_categories.manage",
  stock_moves: "stock_moves.manage",
  suppliers: "suppliers.manage",
  coupons: "coupons.manage",
  clients: "clients.manage",
  client_sheets: "client_sheets.manage",
  client_sheet_templates: "client_sheets.manage",
  client_consents: "client_consents.manage",
  packages: "packages.access",
  package_settings: "packages.settings",
  fidelity: "fidelity.manage",
  fidelity_membership: "fidelity.membership",
  recharges: "fidelity.recharges",
  wallet: "fidelity.wallet",
  promotions: "promotions.manage",
  fidelity_points: "fidelity.points",
  fidelity_levels: "fidelity.levels",
  gifts: "gifts.manage",
  giftbox: "giftbox.manage",
  giftbox_settings: "giftbox.settings",
  giftcard: "giftcard.manage",
  giftcard_settings: "giftcard.settings",
  resources: "resources.manage",
  services: "services.manage",
  service_categories: "service_categories.manage",
  service_recommendations: "service_recommendations.manage",
  cabins: "cabins.manage",
  staff: "staff.manage",
  staff_availability: "staff_availability.manage",
  hours: "hours.manage",
  business_profile: "settings.general",
  locations: "settings.location",
  consent_modules: "consent_modules.manage",
  accessibility: "accessibility.manage",
  roles: "roles.manage",
  automation: "automation.manage",
  marketplace: "settings.general",
};

export const landingPageCandidates: Array<[string, string]> = [
  ["dashboard.view", "dashboard"],
  ["calendar.view", "calendar"],
  ["appointments.manage", "appointments"],
  ["appointments.plan", "appointments_plan"],
  ["pos.manage", "pos"],
  ["pos.movements", "pos_history"],
  ["pos.prepaids", "pos_prepaids"],
  ["pos.preorders", "pos_preorders"],
  ["installments.manage", "installments_manage"],
  ["costs.manage", "costs"],
  ["costs.items", "costs"],
  ["costs.categories", "costs&tab=categories"],
  ["commissions.manage", "commissions"],
  ["products.manage", "products"],
  ["product_categories.manage", "products&action=categories"],
  ["stock_moves.manage", "stock_moves"],
  ["suppliers.manage", "suppliers"],
  ["coupons.manage", "coupons"],
  ["clients.manage", "clients"],
  ["client_sheets.manage", "clients"],
  ["client_consents.manage", "clients"],
  ["packages.clients", "packages&tab=clients"],
  ["packages.catalog", "packages&tab=catalog"],
  ["packages.settings", "package_settings"],
  ["quotes.manage", "quotes"],
  ["quotes.settings", "quote_settings"],
  ["giftbox.manage", "giftbox"],
  ["giftbox.settings", "giftbox_settings"],
  ["giftcard.manage", "giftcard"],
  ["giftcard.settings", "giftcard_settings"],
  ["fidelity.manage", "fidelity"],
  ["fidelity.membership", "fidelity_membership"],
  ["fidelity.recharges", "recharges"],
  ["fidelity.wallet", "wallet"],
  ["credit_movements.manage", "wallet"],
  ["promotions.manage", "promotions"],
  ["fidelity.points", "fidelity_points"],
  ["fidelity.levels", "fidelity_points#livelli-card"],
  ["gifts.manage", "gifts"],
  ["resources.manage", "resources"],
  ["services.manage", "services&tab=services"],
  ["service_categories.manage", "services&tab=categories"],
  ["service_recommendations.manage", "services&tab=recommended"],
  ["cabins.manage", "cabins"],
  ["staff.manage", "staff"],
  ["staff_availability.manage", "staff_availability"],
  ["hours.manage", "hours"],
  ["settings.general", "business_profile"],
  ["settings.location", "locations"],
  ["consent_modules.manage", "consent_modules"],
  ["automation.manage", "automation"],
  ["reports.view", "reports"],
  ["booking.manage", "booking"],
  ["notifications.view", "notifications"],
];

export function definitionsByPerm(): Record<string, PermissionDefinition> {
  return Object.fromEntries(permissionDefinitions.map((definition) => [definition.perm, definition]));
}

export function parentMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  for (const definition of permissionDefinitions) {
    const parents = [
      definition.parent,
      ...(definition.parents ?? []),
    ].filter((value): value is string => Boolean(value));

    if (parents.length > 0) {
      map[definition.perm] = Array.from(new Set(parents));
    }
  }

  return map;
}

export function can(assigned: string[], perm: string): boolean {
  const normalizedPerm = perm.trim();
  if (!normalizedPerm) return false;

  const assignedSet = new Set(assigned.map((item) => item.trim()).filter(Boolean));
  if (assignedSet.has(normalizedPerm)) return true;

  const parents = parentMap();
  const seen = new Set<string>();
  const stack = [...(parents[normalizedPerm] ?? [])];

  while (stack.length > 0) {
    const current = stack.shift()?.trim() ?? "";
    if (!current || seen.has(current)) continue;

    seen.add(current);
    if (assignedSet.has(current)) return true;
    stack.push(...(parents[current] ?? []));
  }

  return false;
}

export function canAny(assigned: string[], perms: string[]): boolean {
  return perms.some((perm) => can(assigned, perm));
}

export function isAssignable(perm: string): boolean {
  const definition = definitionsByPerm()[perm];
  if (!definition) return false;
  return definition.assignable !== false;
}

export function moduleAccessRules(): Record<string, ModuleAccessRule> {
  return {
    "packages.access": {
      label: "Pacchetti",
      children: ["packages.clients", "packages.catalog", "packages.settings"],
      legacyFull: ["packages.manage"],
      requireChild: true,
    },
  };
}

export function moduleChildren(accessPerm: string): string[] {
  return moduleAccessRules()[accessPerm.trim()]?.children ?? [];
}

export function moduleAccessForChild(childPerm: string): string {
  const normalizedChild = childPerm.trim();
  if (!normalizedChild) return "";

  for (const [accessPerm, rule] of Object.entries(moduleAccessRules())) {
    if (rule.children.includes(normalizedChild)) return accessPerm;
  }

  return "";
}

export function isInheritedFromAssigned(assigned: string[], perm: string): boolean {
  const normalizedPerm = perm.trim();
  if (!normalizedPerm) return false;

  const assignedSet = new Set(assigned.map((item) => item.trim()).filter(Boolean));
  const parents = parentMap();
  const seen = new Set<string>();
  const stack = [...(parents[normalizedPerm] ?? [])];

  while (stack.length > 0) {
    const current = stack.shift()?.trim() ?? "";
    if (!current || seen.has(current)) continue;

    seen.add(current);
    if (assignedSet.has(current)) return true;
    stack.push(...(parents[current] ?? []));
  }

  return false;
}

export function normalizeSelectedPerms(selected: string[]): string[] {
  const selectedSet = new Set<string>();

  for (const perm of selected) {
    const normalizedPerm = perm.trim();
    if (normalizedPerm && isAssignable(normalizedPerm)) selectedSet.add(normalizedPerm);
  }

  for (const [accessPerm, rule] of Object.entries(moduleAccessRules())) {
    const hasChild = rule.children.some((childPerm) => selectedSet.has(childPerm));
    if (hasChild && isAssignable(accessPerm)) selectedSet.add(accessPerm);
  }

  for (const perm of Array.from(selectedSet)) {
    if (isInheritedFromAssigned(Array.from(selectedSet), perm)) selectedSet.delete(perm);
  }

  return Array.from(selectedSet);
}

export function validateSelectedPerms(selected: string[]): string | null {
  const selectedSet = new Set(selected.map((perm) => perm.trim()).filter((perm) => perm && isAssignable(perm)));

  for (const [accessPerm, rule] of Object.entries(moduleAccessRules())) {
    if (!selectedSet.has(accessPerm) || !rule.requireChild) continue;

    const hasChild = rule.children.some((childPerm) => selectedSet.has(childPerm));
    if (!hasChild) return `Per attivare ${rule.label} seleziona almeno una funzione del modulo.`;
  }

  return null;
}

export function landingPageForPermissions(assigned: string[], fallback = "accessibility"): string {
  for (const [perm, page] of landingPageCandidates) {
    if (can(assigned, perm)) return page;
  }

  return fallback;
}

export function allAssignablePermissions(): string[] {
  return permissionDefinitions.filter((definition) => isAssignable(definition.perm)).map((definition) => definition.perm);
}

export function permissionForFeature(featureId: string): string {
  return featurePermissionMap[featureId] ?? "tenant.auth";
}

export function permissionsByGroup(): Array<{ groupName: string; definitions: PermissionDefinition[] }> {
  const groups = new Map<string, PermissionDefinition[]>();

  for (const definition of permissionDefinitions) {
    const group = groups.get(definition.groupName) ?? [];
    group.push(definition);
    groups.set(definition.groupName, group);
  }

  return Array.from(groups.entries()).map(([groupName, definitions]) => ({
    groupName,
    definitions: definitions.sort((a, b) => a.sortOrder - b.sortOrder),
  }));
}

import "server-only";

import { businessNowDateTime, businessTodayIso } from "@/lib/business-datetime";
import type { RowDataPacket } from "@/lib/tenant-db";
import { listDbAppointments, listDbLocations, listDbServices } from "@/lib/db-repositories";
import { getManageLocationContext } from "@/lib/manage-locations";
import { dbExecute, dbQuery, quoteIdentifier, columnExists, tableExists, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export type ManageCalendarStaff = {
  id: number;
  name: string;
  email: string;
  color: string;
  photoPath: string;
};

export type ManageCalendarNote = {
  id: number;
  noteDate: string;
  title: string;
  noteText: string;
  createdByName: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
  createdAtLabel: string;
  updatedAtLabel: string;
};

export type ManageCalendarContext = {
  date: string;
  start: string;
  end: string;
  staff: ManageCalendarStaff[];
  staffOrder: number[];
  // The staff id linked to the logged-in operator (matched by email, then name).
  // 0 when the user is not linked to a staff row. Faithful to calendar.php's
  // $currentStaffId — drives the "your column is always first" pin in the Day view.
  currentStaffId: number;
  locations: Awaited<ReturnType<typeof listDbLocations>>;
  services: Awaited<ReturnType<typeof listDbServices>>;
  appointments: Awaited<ReturnType<typeof listDbAppointments>>;
  notes: ManageCalendarNote[];
  countByDate: Record<string, number>;
  businessHours: CalendarBusinessHour[];
  closures: CalendarClosure[];
  exceptions: CalendarBusinessHourException[];
};

type CalendarBusinessHour = {
  id: number;
  dow: number;
  locationId: number | null;
  openTime: string;
  closeTime: string;
  // Second (afternoon) interval of a split schedule, e.g. 09:00-13:00 + 15:00-19:00.
  // The lunch BREAK is the gap between closeTime (13:00) and openTime2 (15:00).
  // Empty strings when the day has no second interval. Faithful to the legacy
  // business_hours.opens2/closes2 columns (getStoreScheduleForDow).
  openTime2: string;
  closeTime2: string;
  isClosed: boolean;
};

type CalendarClosure = {
  id: number;
  date: string;
  locationId: number | null;
  reason: string;
};

type CalendarBusinessHourException = {
  id: number;
  date: string;
  locationId: number | null;
  openTime: string;
  closeTime: string;
  // Second interval for a split special-open day (legacy specialOpenRowForDateKey
  // reads opens2/closes2 too). Empty when single-interval.
  openTime2: string;
  closeTime2: string;
  isClosed: boolean;
};

type TenantTableLike = {
  name: string;
  mode: "shared" | "prefixed" | "base";
  tenantId: number | null;
};

export async function calendarContext(input: {
  slug: string;
  userId?: number;
  // Logged-in user's email/name, used to resolve currentStaffId (the operator's
  // own staff column). Optional so callers without a session still work.
  userEmail?: string;
  userName?: string;
  date?: string;
  start?: string;
  end?: string;
}): Promise<ManageCalendarContext> {
  const date = normalizeDate(input.date) || todayIsoLocal();
  const start = normalizeDate(input.start) || date;
  const end = normalizeDate(input.end) || addDays(start, 1);

  // Tutto il fetch in UN unico Promise.all: il contesto sede serve solo DOPO
  // (per i filtri), e lo schema notes/ordine è auto-assicurato dai rispettivi
  // loader (listCalendarNotes → ensureCalendarNotesTable,
  // getCalendarDayStaffOrder → ensureUserCalendarOrderColumn) — l'ensure
  // seriale in testa era un round trip ridondante.
  //
  // Sede corrente: gli orari/chiusure/eccezioni sono PER SEDE (business_hours.
  // location_id) — il calendario deve usare le righe della sede attiva, non
  // l'unione di tutte (una riga globale/di altra sede non aggiornata terrebbe
  // il calendario sui vecchi orari, es. venerdì fino alle 19 dopo il cambio a 16).
  const [locationContext, staff, staffOrder, locations, services, appointments, notesPayload, businessHoursAll, closuresAll, exceptionsAll] = await Promise.all([
    getManageLocationContext(input.slug).catch(() => null),
    calendarStaff(input.slug),
    getCalendarDayStaffOrder(input.slug, input.userId),
    listDbLocations(input.slug),
    listDbServices({ slug: input.slug }),
    listDbAppointments({ slug: input.slug, start, end }),
    listCalendarNotes({ slug: input.slug, start, end }),
    listBusinessHours(input.slug),
    listClosures({ slug: input.slug, start, end }),
    listBusinessHourExceptions({ slug: input.slug, start, end }),
  ]);
  const currentLocationId = Number(locationContext?.currentLocationId ?? 0) || 0;

  // Orari: fallback PER GIORNO sede -> globale, come la query legacy
  // (calendar.php:171-181 "WHERE location_id IS NULL OR location_id=? ORDER BY
  // dow ASC, (location_id IS NULL) DESC": la riga della sede sovrascrive la
  // globale per quel dow; un dow senza riga di sede usa la globale).
  const byDow = new Map<number, CalendarBusinessHour>();
  for (const b of businessHoursAll) {
    if (b.locationId === null || b.locationId === 0) {
      if (!byDow.has(b.dow)) byDow.set(b.dow, b);
    }
  }
  if (currentLocationId > 0) {
    for (const b of businessHoursAll) {
      if (b.locationId === currentLocationId) byDow.set(b.dow, b);
    }
  }
  const businessHours = byDow.size ? [...byDow.values()] : businessHoursAll;
  // Chiusure/eccezioni: valgono per la sede corrente o globali (NULL).
  const closures = closuresAll.filter((c) => c.locationId === null || c.locationId === 0 || c.locationId === currentLocationId || currentLocationId <= 0);
  const exceptions = exceptionsAll.filter((x) => x.locationId === null || x.locationId === 0 || x.locationId === currentLocationId || currentLocationId <= 0);

  // Appuntamenti PER SEDE come il feed legacy (api_appointments.php action=list
  // :8044-8052 "a.location_id = ? OR a.location_id IS NULL"): il calendario della
  // sede attiva NON deve mostrare gli appuntamenti di un'altra sede (un utente
  // ristretto vedrebbe altrimenti prenotazioni fuori dalla propria sede). Le righe
  // globali (location_id NULL) restano visibili ovunque; senza sedi configurate
  // nessun filtro, come app_current_location_id()==0 (install single-sede).
  // FAIL-CLOSED come la list (api_appointments.php 8005-8016): nessuna sede
  // risolta MA il tenant ha sedi (sessione stantia/sede revocata) -> eventi
  // VUOTI — la pagina usa la list, ma il payload context non deve servire
  // l'unione. allLocations, NON la lista autorizzata (vuota a sedi revocate).
  const scopedAppointments = currentLocationId > 0
    ? appointments.filter((a) => a.locationId === null || a.locationId === undefined || a.locationId === currentLocationId)
    : (locationContext?.allLocations.length ?? 0) > 0
      ? []
      : appointments;

  // Colonne/operatori PER SEDE (calendar.php:149-150 app_filter_staff_ids_by_location):
  // un operatore assegnato SOLO ad un'altra sede non compare come colonna nella sede
  // attiva. Solo con sede attiva; currentLocationId<=0 (single-sede/nessuna) -> tutti.
  // Tendina SERVIZI PER SEDE (calendar.php:30-38 + app_service_location_allowed):
  // PERMISSIVO (a differenza dello staff): un servizio senza righe
  // service_locations resta disponibile ovunque. I due filtri sono
  // indipendenti: in parallelo.
  const [scopedStaff, scopedServices] = currentLocationId > 0
    ? await Promise.all([
        filterStaffByLocation(input.slug, staff, currentLocationId),
        filterServicesByLocation(input.slug, services, currentLocationId),
      ])
    : [staff, services];

  return {
    date,
    start,
    end,
    // Ordine NATURALE (SSO ultimo + nome ASC), come $staff/$staffCols di
    // calendar.php: la tendina filtro Operatore segue questo ordine; il
    // riordino salvato (calendar_day_staff_order) è applicato SOLO alle
    // colonne della vista Giorno dal client (applyStaffDayColumnsOrdering),
    // come nel legacy. staffOrder resta nel payload per quello.
    staff: scopedStaff,
    staffOrder,
    currentStaffId: resolveCurrentStaffId(scopedStaff, input.userEmail, input.userName),
    locations,
    services: scopedServices,
    appointments: scopedAppointments,
    notes: notesPayload.notes,
    countByDate: notesPayload.countByDate,
    businessHours,
    closures,
    exceptions,
  };
}

// Filtro colonne/operatori PER SEDE — port di app_filter_staff_ids_by_location ->
// app_filter_ids_by_location (Helpers.php:1057-1087). STRICT come il legacy: un
// operatore con righe staff_locations è mostrato SOLO nelle sedi elencate; un operatore
// con righe ma NON per la sede corrente viene NASCOSTO. Differenza di SICUREZZA rispetto
// al legacy: se NESSUN operatore ha alcuna riga staff_locations (feature non configurata
// o errore query) restituiamo lo staff invariato invece di azzerare le colonne (il
// legacy mostrerebbe zero colonne). Best-effort su tabella/colonna assenti.
// (Esportata: anche il planner Pianifica filtra il pool operatori per sede con
// la stessa regola — planner_staff_for_service usa app_filter_staff_ids_by_location.)
export async function filterStaffByLocation<T extends { id: number }>(
  slug: string,
  staff: T[],
  locationId: number,
): Promise<T[]> {
  if (!(locationId > 0) || staff.length === 0) return staff;
  const ids = staff.map((s) => Number(s.id)).filter((n) => n > 0);
  if (ids.length === 0) return staff;
  try {
    if (
      !(await tableExists("staff_locations")) ||
      !(await columnExists("staff_locations", "staff_id")) ||
      !(await columnExists("staff_locations", "location_id"))
    ) {
      return staff;
    }
  } catch {
    return staff;
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_locations",
    columns: "staff_id, location_id",
    where: `staff_id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
  }).catch(() => [] as RowDataPacket[]);
  // Nessun mapping affatto (o errore) -> permissivo (safety anti-calendario-vuoto).
  if (rows.length === 0) return staff;
  const allowedHere = new Set<number>();
  for (const r of rows) {
    if (Number(r.location_id ?? 0) === locationId) allowedHere.add(Number(r.staff_id ?? 0));
  }
  // STRICT: tiene solo gli operatori con riga per la sede corrente (array_filter su
  // $allowed nel legacy). Chi ha righe solo per altre sedi -> rimosso.
  return staff.filter((s) => allowedHere.has(Number(s.id)));
}

// Filtro TENDINA servizi PER SEDE — port di app_service_location_allowed /
// app_filter_service_ids_by_location (Helpers.php:1160-1210). PERMISSIVO (a differenza
// dello staff): un servizio SENZA righe service_locations è disponibile OVUNQUE; un
// servizio CON righe è mostrato solo nelle sedi elencate. Best-effort su tabella/colonna
// assenti o su errore -> lista invariata (installazioni legacy).
async function filterServicesByLocation<T extends { id: number }>(
  slug: string,
  services: T[],
  locationId: number,
): Promise<T[]> {
  if (!(locationId > 0) || services.length === 0) return services;
  const ids = services.map((s) => Number(s.id)).filter((n) => n > 0);
  if (ids.length === 0) return services;
  try {
    if (
      !(await tableExists("service_locations")) ||
      !(await columnExists("service_locations", "service_id")) ||
      !(await columnExists("service_locations", "location_id"))
    ) {
      return services;
    }
  } catch {
    return services;
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_locations",
    columns: "service_id, location_id",
    where: `service_id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
  }).catch(() => [] as RowDataPacket[]);
  const hasRows = new Set<number>();      // servizi CON almeno una riga (ristretti)
  const allowedHere = new Set<number>();  // servizi con riga per la sede corrente
  for (const r of rows) {
    const sid = Number(r.service_id ?? 0);
    if (sid <= 0) continue;
    hasRows.add(sid);
    if (Number(r.location_id ?? 0) === locationId) allowedHere.add(sid);
  }
  // PERMISSIVO: servizio senza righe -> mostrato ovunque; con righe -> solo per la sede.
  return services.filter((s) => !hasRows.has(Number(s.id)) || allowedHere.has(Number(s.id)));
}

export async function listCalendarNotes({
  slug,
  start,
  end,
}: {
  slug: string;
  start: string;
  end: string;
}): Promise<{ notes: ManageCalendarNote[]; countByDate: Record<string, number> }> {
  const notesTable = await ensureCalendarNotesTable(slug);
  const normalizedStart = normalizeDate(start);
  const normalizedEnd = normalizeDate(end);
  if (!normalizedStart || !normalizedEnd || normalizedEnd <= normalizedStart) throw new Error("Intervallo non valido.");

  const usersTable = await tenantTable(slug, "users").catch(() => null);
  const clauses = ["n.note_date >= ?", "n.note_date < ?"];
  const params: unknown[] = [normalizedStart, normalizedEnd];
  if (notesTable.mode === "shared" && await columnExists(notesTable.name, "tenant_id")) {
    clauses.unshift("n.tenant_id = ?");
    params.unshift(notesTable.tenantId ?? 0);
  }

  const userJoin = usersTable
    ? `LEFT JOIN ${quoteIdentifier(usersTable.name)} cu ON cu.id = n.created_by ${userTenantJoin("cu", usersTable)}
       LEFT JOIN ${quoteIdentifier(usersTable.name)} uu ON uu.id = n.updated_by ${userTenantJoin("uu", usersTable)}`
    : "";
  const userSelect = usersTable
    ? "cu.name AS created_by_name, uu.name AS updated_by_name"
    : "NULL AS created_by_name, NULL AS updated_by_name";

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT n.id,n.note_date,n.title,n.note_text,n.created_at,n.updated_at,${userSelect}
       FROM ${quoteIdentifier(notesTable.name)} n
       ${userJoin}
      WHERE ${clauses.join(" AND ")}
   ORDER BY n.note_date ASC, n.updated_at DESC, n.id DESC`,
    params,
  );

  const countByDate: Record<string, number> = {};
  const notes = rows.map((row) => {
    const note = mapCalendarNote(row);
    countByDate[note.noteDate] = (countByDate[note.noteDate] ?? 0) + 1;
    return note;
  });

  return { notes, countByDate };
}

export async function saveCalendarNote({
  slug,
  id,
  noteDate,
  title,
  noteText,
  userId,
}: {
  slug: string;
  id?: number;
  noteDate: string;
  title?: string;
  noteText: string;
  userId: number;
}): Promise<ManageCalendarNote> {
  const notesTable = await ensureCalendarNotesTable(slug);
  const normalizedDate = normalizeDate(noteDate);
  const cleanTitle = clean(title ?? "", 190);
  const cleanText = clean(noteText, 20000);
  const noteId = Math.max(0, Number(id ?? 0) || 0);

  if (!normalizedDate) throw new Error("Seleziona un giorno valido.");
  if (!cleanText) throw new Error("Il testo della nota e obbligatorio.");
  if (noteId > 0 && !await calendarNoteExists(notesTable, noteId)) throw new Error("Nota non trovata.");

  if (noteId > 0) {
    const clauses = ["id = ?"];
    // updated_at in ORA DI ROMA esplicita (classe TZ server-safe: NOW() del DB
    // è UTC su Supabase, ma la colonna è wall-time mostrata nel meta della card).
    const params: unknown[] = [normalizedDate, cleanTitle || null, cleanText, userId || null, businessNowDateTime(), noteId];
    if (notesTable.mode === "shared" && await columnExists(notesTable.name, "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(notesTable.tenantId ?? 0);
    }
    await dbExecute(
      `UPDATE ${quoteIdentifier(notesTable.name)}
          SET note_date=?,
              title=?,
              note_text=?,
              updated_by=?,
              updated_at=?
        WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return fetchCalendarNote(slug, noteId);
  }

  const values: Record<string, unknown> = {
    note_date: normalizedDate,
    title: cleanTitle || null,
    note_text: cleanText,
    created_by: userId || null,
    updated_by: userId || null,
  };
  if (notesTable.mode === "shared" && notesTable.tenantId && await columnExists(notesTable.name, "tenant_id")) {
    values.tenant_id = notesTable.tenantId;
  }
  const columns = Object.keys(values).map(quoteIdentifier).join(",");
  const placeholders = Object.keys(values).map(() => "?").join(",");
  // created_at/updated_at in ORA DI ROMA esplicita (come l'update sopra).
  const nowRome = businessNowDateTime();
  const result = await dbExecute(
    `INSERT INTO ${quoteIdentifier(notesTable.name)} (${columns},created_at,updated_at) VALUES(${placeholders},?,?)`,
    [...Object.values(values), nowRome, nowRome],
  );
  return fetchCalendarNote(slug, result.insertId);
}

// Ritorna la data (YYYY-MM-DD) della nota eliminata, o null se non trovata —
// serve alla route per la label del registro attività.
export async function deleteCalendarNote({
  slug,
  id,
}: {
  slug: string;
  id: number;
}): Promise<string | null> {
  const notesTable = await ensureCalendarNotesTable(slug);
  const noteId = Math.max(0, Number(id) || 0);
  if (noteId <= 0) throw new Error("Nota non valida.");
  const clauses = ["id = ?"];
  const params: unknown[] = [noteId];
  if (notesTable.mode === "shared" && await columnExists(notesTable.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(notesTable.tenantId ?? 0);
  }
  const deleted = await dbQuery<RowDataPacket[]>(
    `DELETE FROM ${quoteIdentifier(notesTable.name)} WHERE ${clauses.join(" AND ")} RETURNING note_date`,
    params,
  );
  return deleted[0] ? normalizeDate(deleted[0].note_date) || null : null;
}

export async function getCalendarDayStaffOrder(slug: string, userId = 1): Promise<number[]> {
  await ensureUserCalendarOrderColumn(slug);
  const users = await tenantTable(slug, "users");
  const targetUserId = userId > 0 ? userId : 1;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "users",
    columns: "calendar_day_staff_order",
    where: "id = ?",
    params: [targetUserId],
    limit: 1,
  }).catch(async () => dbQuery<RowDataPacket[]>(`SELECT calendar_day_staff_order FROM ${quoteIdentifier(users.name)} WHERE id=? LIMIT 1`, [targetUserId]));
  const raw = String(rows[0]?.calendar_day_staff_order ?? "");
  return normalizeOrderList(raw ? decodeJsonTolerant(raw) : []);
}

export async function setCalendarDayStaffOrder(slug: string, userId: number, order: unknown): Promise<number[]> {
  await ensureUserCalendarOrderColumn(slug);
  const normalized = normalizeOrderList(Array.isArray(order) ? order : decodeJsonTolerant(String(order ?? "")));
  const users = await tenantTable(slug, "users");
  const targetUserId = userId > 0 ? userId : 1;
  await tenantUpdate({ slug, table: "users", id: targetUserId, values: { calendar_day_staff_order: JSON.stringify(normalized) } })
    .catch(async () => {
      await dbExecute(
        `UPDATE ${quoteIdentifier(users.name)} SET calendar_day_staff_order=? WHERE id=?`,
        [JSON.stringify(normalized), targetUserId],
      );
    });
  return normalized;
}

async function calendarStaff(slug: string): Promise<ManageCalendarStaff[]> {
  const staffTable = await tenantTable(slug, "staff");
  const hasColor = await columnExists(staffTable.name, "calendar_color");
  const hasPhoto = await columnExists(staffTable.name, "photo_path");
  const hasSortOrder = await columnExists(staffTable.name, "sort_order");
  const columns = ["id", "full_name", "email"];
  if (hasColor) columns.push("calendar_color");
  if (hasPhoto) columns.push("photo_path");

  // SSO ("Senza Operatore") column (calendar.php 54-60): shown ONLY when at
  // least one active service is flagged no_operator; otherwise the special
  // 'SSO' staff row is filtered out. When shown, SSO sorts LAST.
  let includeSso = false;
  try {
    const servicesTable = await tenantTable(slug, "services");
    if (await columnExists(servicesTable.name, "no_operator")) {
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "services",
        columns: "COUNT(*) AS n",
        where: "COALESCE(is_active, 1) = 1 AND no_operator = 1",
      });
      includeSso = Number(rows[0]?.n ?? 0) > 0;
    }
  } catch {
    includeSso = false;
  }
  if (includeSso) {
    // ensure_sso_staff_exists: create the special staff row if missing (best-effort).
    try {
      const existing = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "id", where: "full_name = 'SSO'", limit: 1 });
      if (!existing[0]) await tenantInsert(staffTable, { full_name: "SSO", is_active: 1 });
    } catch {
      // a failed ensure just leaves the column out
    }
  }

  const ssoLast = "(CASE WHEN full_name = 'SSO' THEN 1 ELSE 0 END) ASC";
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: columns.map(quoteIdentifier).join(","),
    where: `COALESCE(is_active, 1) = 1${includeSso ? "" : " AND full_name <> 'SSO'"}`,
    orderBy: hasSortOrder ? `${ssoLast}, sort_order ASC, full_name ASC, id ASC` : `${ssoLast}, full_name ASC, id ASC`,
  });

  return rows.map((row, index) => ({
    id: Number(row.id ?? 0),
    name: String(row.full_name ?? `Operatore #${index + 1}`),
    email: String(row.email ?? ""),
    color: normalizeColor(row.calendar_color),
    photoPath: String(row.photo_path ?? ""),
  })).filter((staff) => staff.id > 0);
}

async function fetchCalendarNote(slug: string, id: number): Promise<ManageCalendarNote> {
  const notesTable = await ensureCalendarNotesTable(slug);
  const usersTable = await tenantTable(slug, "users").catch(() => null);
  const clauses = ["n.id = ?"];
  const params: unknown[] = [id];
  if (notesTable.mode === "shared" && await columnExists(notesTable.name, "tenant_id")) {
    clauses.push("n.tenant_id = ?");
    params.push(notesTable.tenantId ?? 0);
  }
  // Join users like listCalendarNotes so the note returned right after a save carries the
  // author name (created_by_name / updated_by_name) instead of NULL — the card meta shows
  // the author without a reload (port of api_calendar_notes.php calendar_notes_fetch_row).
  const userJoin = usersTable
    ? `LEFT JOIN ${quoteIdentifier(usersTable.name)} cu ON cu.id = n.created_by ${userTenantJoin("cu", usersTable)}
       LEFT JOIN ${quoteIdentifier(usersTable.name)} uu ON uu.id = n.updated_by ${userTenantJoin("uu", usersTable)}`
    : "";
  const userSelect = usersTable
    ? "cu.name AS created_by_name, uu.name AS updated_by_name"
    : "NULL AS created_by_name, NULL AS updated_by_name";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT n.id,n.note_date,n.title,n.note_text,n.created_at,n.updated_at,${userSelect}
       FROM ${quoteIdentifier(notesTable.name)} n
       ${userJoin}
      WHERE ${clauses.join(" AND ")}
      LIMIT 1`,
    params,
  );
  if (!rows[0]) throw new Error("Nota non trovata.");
  return mapCalendarNote(rows[0]);
}

async function calendarNoteExists(table: TenantTableLike, id: number): Promise<boolean> {
  const clauses = ["id = ?"];
  const params: unknown[] = [id];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT id FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")} LIMIT 1`, params);
  return rows.length > 0;
}

async function ensureCalendarNotesTable(slug: string): Promise<TenantTableLike> {
  const users = await tenantTable(slug, "users");
  const table: TenantTableLike = users.mode === "prefixed"
    ? { name: users.name.replace(/users$/, "calendar_notes"), mode: "prefixed", tenantId: null }
    : users.mode === "shared"
      ? { name: "calendar_notes", mode: "shared", tenantId: users.tenantId }
      : { name: "calendar_notes", mode: "base", tenantId: null };
  if (!await tableExists(table.name)) {
    const tenantColumn = table.mode === "shared" ? "`tenant_id` INT(11) NULL DEFAULT NULL," : "";
    const tenantKey = table.mode === "shared" ? "KEY `idx_calendar_notes_tenant_date` (`tenant_id`,`note_date`)," : "";

    await dbExecute(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (
        \`id\` INT(11) NOT NULL AUTO_INCREMENT,
        ${tenantColumn}
        \`note_date\` DATE NOT NULL,
        \`title\` VARCHAR(190) NULL DEFAULT NULL,
        \`note_text\` TEXT NOT NULL,
        \`created_by\` INT(11) NULL DEFAULT NULL,
        \`updated_by\` INT(11) NULL DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        ${tenantKey}
        KEY \`idx_calendar_notes_date\` (\`note_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
  }

  if (table.mode === "shared") {
    await addColumnIfMissing(table.name, "tenant_id", `${quoteIdentifier("tenant_id")} INTEGER NULL DEFAULT NULL`);
  }

  return table;
}

async function ensureUserCalendarOrderColumn(slug: string): Promise<void> {
  const users = await tenantTable(slug, "users");
  await addColumnIfMissing(users.name, "calendar_day_staff_order", `${quoteIdentifier("calendar_day_staff_order")} TEXT NULL DEFAULT NULL`);
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(table, column)) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
}

async function listBusinessHours(slug: string): Promise<CalendarBusinessHour[]> {
  if (!await tableExistsForTenant(slug, "business_hours")) return [];
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "business_hours", orderBy: "dow ASC, location_id ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    dow: Number(row.dow ?? 0),
    locationId: nullableNumber(row.location_id),
    openTime: timeString(row.opens ?? row.open_time ?? row.opens_at ?? row.start_time),
    closeTime: timeString(row.closes ?? row.close_time ?? row.closes_at ?? row.end_time),
    // Second interval (split schedule). Same fallback style as opens/closes; the
    // gap between closeTime and openTime2 is the store BREAK (lunch). Empty when
    // the row has no second interval, so callers can detect a single-interval day.
    openTime2: timeString(row.opens2 ?? row.open_time2 ?? row.opens2_at ?? row.start_time2),
    closeTime2: timeString(row.closes2 ?? row.close_time2 ?? row.closes2_at ?? row.end_time2),
    isClosed: Number(row.is_closed ?? 0) === 1,
  }));
}

async function listClosures({ slug, start, end }: { slug: string; start: string; end: string }): Promise<CalendarClosure[]> {
  if (!await tableExistsForTenant(slug, "closures")) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "closures",
    where: "date >= ? AND date < ?",
    params: [start, end],
    orderBy: "date ASC, location_id ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    date: normalizeDate(row.date) || "",
    locationId: nullableNumber(row.location_id),
    reason: String(row.reason ?? row.title ?? ""),
  }));
}

async function listBusinessHourExceptions({ slug, start, end }: { slug: string; start: string; end: string }): Promise<CalendarBusinessHourException[]> {
  if (!await tableExistsForTenant(slug, "business_hours_exceptions")) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours_exceptions",
    where: "date >= ? AND date < ?",
    params: [start, end],
    orderBy: "date ASC, location_id ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    date: normalizeDate(row.date) || "",
    locationId: nullableNumber(row.location_id),
    openTime: timeString(row.opens ?? row.open_time ?? row.opens_at ?? row.start_time),
    closeTime: timeString(row.closes ?? row.close_time ?? row.closes_at ?? row.end_time),
    openTime2: timeString(row.opens2 ?? row.open_time2 ?? row.opens2_at ?? row.start_time2),
    closeTime2: timeString(row.closes2 ?? row.close_time2 ?? row.closes2_at ?? row.end_time2),
    isClosed: Number(row.is_closed ?? 0) === 1,
  }));
}

async function tableExistsForTenant(slug: string, table: string): Promise<boolean> {
  try {
    await tenantTable(slug, table);
    return true;
  } catch {
    return false;
  }
}

function mapCalendarNote(row: RowDataPacket): ManageCalendarNote {
  return {
    id: Number(row.id ?? 0),
    noteDate: normalizeDate(row.note_date) || "",
    title: String(row.title ?? ""),
    noteText: String(row.note_text ?? ""),
    createdByName: String(row.created_by_name ?? ""),
    updatedByName: String(row.updated_by_name ?? ""),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    createdAtLabel: dateLabel(row.created_at),
    updatedAtLabel: dateLabel(row.updated_at),
  };
}

// Resolve the staff id linked to the logged-in user. Faithful to calendar.php:
// preferred match is staff.email == user.email; fallback is staff.name == user.name
// (both compared case-insensitively, trimmed). Returns 0 when no staff row matches.
function resolveCurrentStaffId(
  staff: ManageCalendarStaff[],
  userEmail?: string,
  userName?: string,
): number {
  const email = String(userEmail ?? "").trim().toLowerCase();
  const name = String(userName ?? "").trim().toLowerCase();

  if (email) {
    for (const member of staff) {
      const memberEmail = String(member.email ?? "").trim().toLowerCase();
      if (member.id > 0 && memberEmail && memberEmail === email) return member.id;
    }
  }
  if (name) {
    for (const member of staff) {
      const memberName = String(member.name ?? "").trim().toLowerCase();
      if (member.id > 0 && memberName && memberName === name) return member.id;
    }
  }
  return 0;
}

// json_decode PHP (api_user_prefs.php 53/82): su JSON corrotto torna null —
// mai un errore. JSON.parse invece lancia (e la route rispondeva 400 col
// SyntaxError inglese): qui si replica la tolleranza del legacy.
function decodeJsonTolerant(raw: string): unknown {
  const s = raw.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeOrderList(value: unknown): number[] {
  const input = Array.isArray(value) ? value : [];
  const output: number[] = [];
  const seen = new Set<number>();
  for (const item of input) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= 200) break;
  }
  return output;
}

function userTenantJoin(alias: string, table: TenantTableLike): string {
  return table.mode === "shared" && table.tenantId && "tenant_id" in table
    ? `AND ${alias}.tenant_id = ${Number(table.tenantId)}`
    : "";
}

function normalizeDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const date = new Date(`${raw}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return "";
  return dateIsoLocal(date);
}

// Giorno "oggi" in ora di ROMA (classe TZ server-safe: new Date() locale del
// server sbaglia giorno a cavallo di mezzanotte su un server UTC).
function todayIsoLocal(): string {
  return businessTodayIso();
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return dateIsoLocal(next);
}

function dateIsoLocal(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function clean(value: string, max: number): string {
  // Come calendar_notes_trim (api_calendar_notes.php:37-48): solo trim + taglio a
  // maxLen. NON collassare gli spazi interni: le note multi-riga devono conservare
  // gli a-capo (prima .replace(/\s+/g," ") li perdeva).
  return value.trim().slice(0, max);
}

// Come $staffCols di calendar.php (83-95): normalizza '#rrggbb' (prefissa '#'
// se manca) e restituisce '' quando non valido — il FALLBACK cromatico è del
// CLIENT (staffColorHex: palette per abs(id)%10), non del server.
function normalizeColor(value: unknown): string {
  let raw = String(value ?? "").trim();
  if (raw !== "" && !raw.startsWith("#")) raw = `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : "";
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timeString(value: unknown): string {
  return String(value ?? "").slice(0, 5);
}

function dateString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return mysqlDate(value);
  return String(value);
}

function dateLabel(value: unknown): string {
  const raw = dateString(value);
  if (!raw) return "";
  const date = new Date(raw.replace(" ", "T"));
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

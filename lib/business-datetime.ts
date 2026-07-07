import "server-only";

// Data/ora del "giorno lavorativo" ANCORATE a Europe/Rome (il fuso del business), a
// prescindere dal TZ del runtime: il legacy PHP usa sempre date()/DateTimeZone('Europe/Rome'),
// mentre Next su AWS Amplify/Lambda gira in UTC. Senza questo ancoraggio, nella finestra serale
// (~23:00-24:00 UTC = 01:00-02:00 Rome d'estate) un `new Date()` in UTC restituisce il GIORNO
// PRECEDENTE rispetto al legacy, sfasando scadenze prepagati/preordini, prime scadenze rate,
// boundary "scaduto" e date-cutoff dei report. Questi helper replicano il wall-clock Rome.
const ROME_TZ = "Europe/Rome";

// "YYYY-MM-DD" per l'istante dato (default: adesso) letto nel fuso Europe/Rome.
export function businessTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// "YYYY-MM-DD HH:MM:SS" per l'istante dato (default: adesso) nel fuso Europe/Rome — come
// il legacy date('Y-m-d H:i:s').
export function businessNowDateTime(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // Alcune implementazioni Intl rendono la mezzanotte come "24" invece di "00": normalizza.
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

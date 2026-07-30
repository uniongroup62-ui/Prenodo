import { permanentRedirect } from "next/navigation";

// Separazione domini (2026-07-23): la ROOT del dominio pubblico non è più il
// marketplace — la serve il sito vetrina (progetto PrenodoFrontend), mentre il
// marketplace vive alla sua URL canonica /attivita.
//
// Qui resta un redirect PERMANENTE (308, equivalente a 301 per i motori di
// ricerca) così che:
//  - i vecchi link alla root finiscano sul marketplace senza perdere valore SEO;
//  - in sviluppo (localhost:3000, senza il routing del CDN davanti) la root
//    porti comunque a una pagina utile;
//  - in produzione questo codice non venga nemmeno raggiunto per "/", perché il
//    CDN instrada la root alla vetrina (vedi docs/domini-routing.md).
export default function Home() {
  permanentRedirect("/attivita");
}

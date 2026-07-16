"use client";

import { useEffect, useRef, useState } from "react";

// Combobox cliente con RICERCA SERVER-SIDE (miglioria 2026-07-16): sostituisce
// i combobox filtro che scaricavano l'INTERA anagrafica a ogni load della
// lista (GiftBox/GiftCard "Mittente", Preventivi/Pacchetti "Cliente") — costo
// che cresceva linearmente coi clienti. Il dropdown parte vuoto e interroga
// l'endpoint di ricerca del PROPRIO modulo (gate del modulo, non clients.*)
// solo quando si digita (debounce 300ms, min 2 caratteri, max 50 risultati
// lato server). Il label del cliente preselezionato dall'URL arriva dal
// payload lista (selectedClientLabel), non dall'anagrafica completa.

export type ClientSearchItem = { id: string; label: string };

export function ClientSearchCombobox({
  value,
  initialLabel = "",
  placeholder = "Tutti",
  searchUrl,
  onChange,
  disabled = false,
}: {
  value: string;
  // Label del cliente già selezionato (es. filtro ?client_id= dall'URL).
  initialLabel?: string;
  placeholder?: string;
  // Costruisce l'URL di ricerca del modulo (q già trim-mato, mai vuoto).
  searchUrl: (q: string) => string;
  onChange: (id: string, label: string) => void;
  // Come il disabled di un <select>: toggle bloccato, dropdown mai aperto.
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ClientSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  // Label mostrato: la selezione fatta QUI vince; altrimenti initialLabel
  // (che arriva ASINCRONO col payload lista) — derivato, niente effect.
  const [overrideLabel, setOverrideLabel] = useState<string | null>(null);
  const selectedLabel = overrideLabel ?? initialLabel;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);


  function runSearch(qRaw: string) {
    const q = qRaw.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) {
      setItems([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      const seq = ++seqRef.current;
      fetch(searchUrl(q))
        .then((r) => r.json())
        .then((j) => {
          if (seq !== seqRef.current) return; // risposta superata da una digitazione successiva
          const rows = Array.isArray(j.clients) ? j.clients : Array.isArray(j.items) ? j.items : [];
          setItems(
            rows
              .map((c: { id?: number | string; full_name?: string; label?: string; email?: string }) => ({
                id: String(c.id ?? ""),
                label: String(c.full_name ?? c.label ?? "").trim() || `#${c.id}`,
              }))
              .filter((c: ClientSearchItem) => c.id !== "" && c.id !== "0"),
          );
        })
        .catch(() => setItems([]))
        .finally(() => {
          if (seq === seqRef.current) setSearching(false);
        });
    }, 300);
  }

  const hasSelection = value !== "" && value !== "0";

  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {hasSelection ? (
          <span className="app-combobox-text">{selectedLabel || `#${value}`}</span>
        ) : (
          <span className="text-muted app-combobox-placeholder">{placeholder}</span>
        )}
      </button>
      <div className={`dropdown-menu p-2 w-100 ${open ? "show" : ""}`}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca cliente…"
          autoComplete="off"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            runSearch(e.target.value);
          }}
        />
        <div className="app-combobox-list mt-2" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              onChange("", "");
              setOverrideLabel("");
              setSearch("");
              setItems([]);
              setOpen(false);
            }}
          >
            {placeholder}
          </button>
          {search.trim().length < 2 ? (
            <div className="text-muted small px-2 py-1">Digita almeno 2 caratteri…</div>
          ) : searching ? (
            <div className="text-muted small px-2 py-1">Ricerca…</div>
          ) : items.length === 0 ? (
            <div className="text-muted small px-2 py-1">Nessun risultato</div>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`dropdown-item ${it.id === value ? "active" : ""}`}
                onClick={() => {
                  onChange(it.id, it.label);
                  setOverrideLabel(it.label);
                  setSearch("");
                  setItems([]);
                  setOpen(false);
                }}
              >
                {it.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

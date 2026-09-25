"use client";

import { useState } from "react";

/**
 * New Update #7 — the Current-Destination form's two dependent fields.
 *
 * Duty belongs to the destination relationship, so it is only meaningful (and
 * only submitted) when a destination is selected:
 *   • no destination selected  → the duty control is disabled and NOT part of the
 *     submitted form data, so the "clear Current Destination" flow is unchanged;
 *   • a destination selected   → the duty control becomes required and offers
 *     exactly the two sanctioned values (Destinado / Katuwang).
 *
 * Client-side state is convenience only: `changeCurrentDestination` rejects a set
 * without a valid duty server-side, so the rule holds even with scripting off or
 * a forged request.
 */
export function DestinationFields({
  dakos,
  currentDuty,
}: {
  dakos: Array<{ id: string; dakoCode: string; name: string }>;
  /** Duty of the CURRENT relationship — used only to pre-fill a new selection. */
  currentDuty: "DESTINADO" | "KATUWANG" | null;
}) {
  const [destinationId, setDestinationId] = useState("");
  const [duty, setDuty] = useState("");

  const needsDuty = destinationId !== "";

  function onDestinationChange(value: string) {
    setDestinationId(value);
    if (value === "") {
      setDuty("");
      return;
    }
    // Prefill from the CURRENT relationship duty only while it still applies
    // (the form starts with no destination selected).
    if (duty === "" && currentDuty) setDuty(currentDuty);
  }

  return (
    <>
      <label className="field">
        <span>New Current Destination (ACTIVE dako only) — leave blank to clear</span>
        <select
          name="newDestinationId"
          value={destinationId}
          onChange={(e) => onDestinationChange(e.target.value)}
        >
          <option value="">— none (clear Current Destination) —</option>
          {dakos.map((d) => (
            <option key={d.id} value={d.id}>{d.dakoCode} · {d.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Duty at this destination <em aria-hidden="true"> *</em></span>
        <select
          name="duty"
          value={duty}
          disabled={!needsDuty}
          required={needsDuty}
          onChange={(e) => setDuty(e.target.value)}
        >
          <option value="">— select duty —</option>
          <option value="DESTINADO">Destinado</option>
          <option value="KATUWANG">Katuwang</option>
        </select>
      </label>
      <p className="info-note">
        Duty is recorded <em>with</em> the destination, so changing destination preserves the duty held at the previous
        one in Destination History. Only Destinado and Katuwang are allowed.
      </p>
    </>
  );
}

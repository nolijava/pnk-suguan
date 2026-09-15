export function StateCard({ kind, message }: { kind: "loading" | "empty" | "error"; message: string }) {
  return (
    <div className={`state-card state-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <strong>{kind === "loading" ? "Loading…" : kind === "error" ? "Something went wrong" : "Nothing here yet"}</strong>
      <p>{message}</p>
    </div>
  );
}

export function Notice({ kind, children }: { kind: "success" | "error" | "info"; children: React.ReactNode }) {
  return <p className={kind === "success" ? "notice" : kind === "error" ? "error" : "info-note"}>{children}</p>;
}

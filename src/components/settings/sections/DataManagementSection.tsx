import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Archive, Download, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { Button, ConfirmModal } from "../../ui";
import { useAppStore } from "../../../store";

interface BackupResult { path: string; files: number }

export function DataManagementSection() {
  const setToast = useAppStore((s) => s.setToast);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [restorePath, setRestorePath] = useState<string | null>(null);

  const createBackup = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const selected = await save({
      title: "Save Wordlyte backup",
      defaultPath: `Wordlyte-${date}.wordlyte-backup`,
      filters: [{ name: "Wordlyte Backup", extensions: ["wordlyte-backup"] }],
    });
    if (!selected) return;
    setBusy("backup");
    try {
      const result = await invoke<BackupResult>("backup_create", { path: selected });
      setToast(`Backup created (${result.files} files)`);
    } catch (error) {
      setToast(`Backup failed: ${error}`);
    } finally {
      setBusy(null);
    }
  };

  const chooseRestore = async () => {
    const selected = await open({
      title: "Choose a Wordlyte backup",
      multiple: false,
      directory: false,
      filters: [{ name: "Wordlyte Backup", extensions: ["wordlyte-backup"] }],
    });
    if (typeof selected === "string") setRestorePath(selected);
  };

  const restore = async () => {
    if (!restorePath) return;
    setBusy("restore");
    try {
      await invoke("backup_stage_restore", { path: restorePath });
      setToast("Backup validated. Restarting Wordlyte to restore it…");
      await invoke("restart_application");
    } catch (error) {
      setToast(`Restore failed: ${error}`);
      setBusy(null);
      setRestorePath(null);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-console-border bg-console-surface p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-state-success/10 p-2 text-state-success"><Archive size={18} /></div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-console-text">Church data backup</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-console-text-muted">
              Saves services, songs, presentations, scenes, templates, settings, media, fonts, and output configuration
              into one portable archive.
            </p>
            <Button variant="primary" size="md" className="mt-3" onClick={createBackup} loading={busy === "backup"} disabled={busy !== null}>
              <Download size={13} /> Create Backup
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-console-border bg-console-surface p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-state-warning/10 p-2 text-state-warning"><Upload size={18} /></div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-console-text">Restore from backup</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-console-text-muted">
              Wordlyte validates the archive first, preserves the current installation in a pre-restore folder, and
              applies the replacement only during restart.
            </p>
            <Button variant="ghost" size="md" className="mt-3" onClick={chooseRestore} disabled={busy !== null}>
              <RefreshCw size={13} /> Choose Backup…
            </Button>
          </div>
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-md border border-console-border bg-console-canvas/50 p-3 text-[10px] leading-relaxed text-console-text-subtle">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-state-success" />
        Machine-bound licenses, remote-control credentials, TLS keys, logs, recordings, and downloadable Bible assets
        are intentionally excluded. Activate the destination computer separately after a transfer.
      </div>

      <ConfirmModal
        open={!!restorePath}
        title="Restore this Wordlyte backup?"
        description="The current database and content folders will be replaced after a restart. A timestamped copy of the current data will be retained for recovery."
        confirmLabel={busy === "restore" ? "Validating…" : "Restore & Restart"}
        confirmVariant="primary"
        onConfirm={restore}
        onClose={() => { if (!busy) setRestorePath(null); }}
      />
    </div>
  );
}

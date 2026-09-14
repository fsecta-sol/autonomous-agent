"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/providers/auth";

export function ProfileView() {
  const { profile, saveProfile } = useAuth();
  // the profile is read synchronously from the client store on mount, so the
  // form can initialize from it directly (this view never server-renders)
  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [role, setRole] = useState(profile?.role ?? "");
  const [status, setStatus] = useState("Local only");
  const [saved, setSaved] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveProfile({ name: name.trim(), email: email.trim(), role: role.trim() });
    setStatus("Saved in this browser");
    setSaved(true);
  }

  return (
    <section className="view active" data-od-id="view-profile">
      <div className="settings-index">
        <div className="panel-header">
          <h2>Profile</h2>
          <div className="graph-meta">
            <span>Operator identity</span>
          </div>
        </div>
        <form className="settings-body" onSubmit={onSubmit}>
          <div className="panel-header sub">
            <h2>Your details</h2>
            <span className={`cs-status ${saved ? "saved" : ""}`} aria-live="polite">
              {status}
            </span>
          </div>
          <label className="cs-field">
            <span className="cs-label">Name</span>
            <input type="text" placeholder="Operator name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="cs-field">
            <span className="cs-label">Email</span>
            <input type="email" placeholder="operator@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="cs-field">
            <span className="cs-label">Role</span>
            <input type="text" placeholder="Swarm operator" autoComplete="organization-title" value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <div className="cs-foot">
            <button className="cs-save" type="submit">
              Save profile
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

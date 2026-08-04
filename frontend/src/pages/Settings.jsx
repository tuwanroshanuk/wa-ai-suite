import { useEffect, useState } from "react";
import { api } from "../api";

export default function Settings() {
  const [assets, setAssets] = useState([]);
  const [name, setName] = useState("");
  const [file, setFile] = useState(null);

  function load() {
    api.get("/api/audio").then((r) => setAssets(r.data));
  }
  useEffect(load, []);

  async function upload() {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("name", name || file.name);
    await api.post("/api/audio", form, { headers: { "Content-Type": "multipart/form-data" } });
    setName("");
    setFile(null);
    load();
  }

  return (
    <div>
      <h1>Settings</h1>

      <div className="card">
        <h3>Audio library (free pre-recorded clips)</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          Upload greeting / menu audio files here, then reference their ID in
          the "Play audio clip" node inside the Bot Flow builder.
        </p>
        <input placeholder="Clip name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files[0])} />
        <button className="primary" onClick={upload}>Upload</button>

        <table style={{ marginTop: 16 }}>
          <thead><tr><th>ID</th><th>Name</th></tr></thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}><td>{a.id}</td><td>{a.name}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Credentials</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          All WhatsApp, Gemini, and TTS credentials are configured via environment
          variables on the server (<code>.env</code> file) - see the README for
          the full list. They are never entered in this UI for security.
        </p>
      </div>
    </div>
  );
}

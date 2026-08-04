import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";

export default function Sidebar() {
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  return (
    <div className="sidebar">
      <div className="brand">WA AI Suite</div>
      <NavLink to="/" end>Dashboard</NavLink>
      <NavLink to="/conversations">Conversations</NavLink>
      <NavLink to="/flows">Bot Flows</NavLink>
      <NavLink to="/calls">Calls</NavLink>
      <NavLink to="/ai-agent">AI Agent</NavLink>
      <NavLink to="/settings">Settings</NavLink>
      <div style={{ marginTop: "auto", padding: "12px 20px" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>{user?.email}</div>
        <button
          className="secondary"
          onClick={() => {
            logout();
            navigate("/login");
          }}
        >
          Log out
        </button>
      </div>
    </div>
  );
}

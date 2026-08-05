import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Conversations from "./pages/Conversations.jsx";
import FlowBuilder from "./pages/FlowBuilder.jsx";
import Calls from "./pages/Calls.jsx";
import Settings from "./pages/Settings.jsx";
import Sidebar from "./components/Sidebar.jsx";
import IncomingCallOverlay from "./components/IncomingCallOverlay.jsx";

function Protected({ children }) {
  const token = useAuthStore((state) => state.token);
  if (!token) return <Navigate to="/login" replace />;
  return (
    <div className="layout">
      <Sidebar />
      <div className="main">{children}</div>
      <IncomingCallOverlay />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/conversations" element={<Protected><Conversations /></Protected>} />
      <Route path="/ivr" element={<Protected><FlowBuilder /></Protected>} />
      <Route path="/flows" element={<Navigate to="/ivr" replace />} />
      <Route path="/ai-agent" element={<Navigate to="/ivr" replace />} />
      <Route path="/calls" element={<Protected><Calls /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

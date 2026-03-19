import { Routes, Route } from "react-router-dom";
import Nav from "./components/Nav";
import ReviewQueue from "./pages/ReviewQueue";
import SystemOverview from "./pages/SystemOverview";
import AuditLog from "./pages/AuditLog";

export default function App() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-7xl">
        <Routes>
          <Route path="/" element={<ReviewQueue />} />
          <Route path="/overview" element={<SystemOverview />} />
          <Route path="/audit" element={<AuditLog />} />
        </Routes>
      </main>
    </div>
  );
}

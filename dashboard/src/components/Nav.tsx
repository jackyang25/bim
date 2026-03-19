import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Review Queue" },
  { to: "/overview", label: "System Overview" },
  { to: "/audit", label: "Audit Log" },
];

export default function Nav() {
  return (
    <nav className="border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-8">
        <span className="text-sm font-semibold tracking-wide text-gray-500 uppercase">
          BIM Dashboard
        </span>
        <div className="flex gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-gray-900 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}

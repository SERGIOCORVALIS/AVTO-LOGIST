import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { homePath, useAuth } from "../../auth/AuthContext";
import { navForRole } from "../../auth/paths";
import { useEffect } from "react";

export function AppShell() {
  const { user, logout } = useAuth();
  const { role } = useParams<{ role: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user || !role) return;
    if (role !== "director" && role !== "manager") {
      navigate(homePath(user.role), { replace: true });
      return;
    }
    if (user.role !== role) navigate(homePath(user.role), { replace: true });
  }, [user, role, navigate]);

  if (!user || !role) return null;
  const nav = navForRole(user.role);
  const base = `/${user.role}`;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 shrink-0 flex-col border-r border-gold-500/20 bg-navy-950/90">
        <div className="flex items-center gap-3 border-b border-gold-500/20 px-4 py-5">
          <img src="/brand/logo.png" alt="TRANSINVEST" className="h-12 w-12 object-contain" />
          <div>
            <p className="font-serif text-sm tracking-[0.18em] text-gold-300">TRANSINVEST</p>
            <p className="text-[10px] uppercase tracking-widest text-white/50">Premium robot</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              end={item.to === ""}
              to={item.to ? `${base}/${item.to}` : base}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? "bg-gold-500/15 text-gold-300"
                    : "text-white/70 hover:bg-navy-800 hover:text-white"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gold-500/20 p-4">
          <p className="text-sm text-white">{user.name}</p>
          <p className="text-xs text-gold-300/80">
            {user.role === "director" ? "Директор" : "Менеджер"}
          </p>
          <button
            className="mt-3 text-xs text-white/50 hover:text-gold-300"
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            Выйти
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}

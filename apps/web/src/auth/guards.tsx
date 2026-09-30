import { Navigate, useLocation } from "react-router-dom";
import { homePath, useAuth } from "./AuthContext";
import type { ReactNode } from "react";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-gold-300">
        Загрузка кабинета…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to={homePath(user.role)} replace />;
  return <>{children}</>;
}

export function DirectorOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role !== "director") {
    return <Navigate to={homePath(user.role)} replace />;
  }
  return <>{children}</>;
}

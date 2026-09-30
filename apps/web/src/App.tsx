import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { DirectorOnly, GuestOnly, RequireAuth } from "./auth/guards";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/shared/DashboardPage";
import { DealsPage } from "./pages/shared/DealsPage";
import { DealCardPage } from "./pages/shared/DealCardPage";
import { EscalationsPage } from "./pages/shared/EscalationsPage";
import { DocumentsPage } from "./pages/shared/DocumentsPage";
import { ClientsPage } from "./pages/shared/ClientsPage";
import { ClientCardPage } from "./pages/shared/ClientCardPage";
import { PolicyPage } from "./pages/director/PolicyPage";
import { PlaybooksPage } from "./pages/director/PlaybooksPage";
import { PartnersPage } from "./pages/director/PartnersPage";
import { ManagersPage } from "./pages/director/ManagersPage";
import { CompanyPage } from "./pages/director/CompanyPage";
import { ParsersPage } from "./pages/director/ParsersPage";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route
          path="/login"
          element={
            <GuestOnly>
              <LoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/:role"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="deals" element={<DealsPage />} />
          <Route path="deals/:id" element={<DealCardPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:id" element={<ClientCardPage />} />
          <Route path="escalations" element={<EscalationsPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route
            path="policy"
            element={
              <DirectorOnly>
                <PolicyPage />
              </DirectorOnly>
            }
          />
          <Route
            path="playbooks"
            element={
              <DirectorOnly>
                <PlaybooksPage />
              </DirectorOnly>
            }
          />
          <Route
            path="partners"
            element={
              <DirectorOnly>
                <PartnersPage />
              </DirectorOnly>
            }
          />
          <Route
            path="parsers"
            element={
              <DirectorOnly>
                <ParsersPage />
              </DirectorOnly>
            }
          />
          <Route
            path="managers"
            element={
              <DirectorOnly>
                <ManagersPage />
              </DirectorOnly>
            }
          />
          <Route
            path="company"
            element={
              <DirectorOnly>
                <CompanyPage />
              </DirectorOnly>
            }
          />
        </Route>
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}

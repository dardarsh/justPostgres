import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.js";
import AuthPage from "./pages/AuthPage.js";
import ProjectsPage from "./pages/ProjectsPage.js";
import ProjectShell from "./pages/ProjectShell.js";
import ProjectDetailPage from "./pages/ProjectDetailPage.js";
import DataPage from "./pages/DataPage.js";
import SqlPage from "./pages/SqlPage.js";
import BackupsPage from "./pages/BackupsPage.js";
import BranchesPage from "./pages/BranchesPage.js";
import ExtensionsPage from "./pages/ExtensionsPage.js";
import UpgradePage from "./pages/UpgradePage.js";
import ApiPage from "./pages/ApiPage.js";
import JobsPage from "./pages/JobsPage.js";
import HealthPage from "./pages/HealthPage.js";
import AdminPage from "./pages/AdminPage.js";
import { api } from "./lib/api.js";

export default function App() {
  // The server decides whether this instance needs setup, needs a login, or is
  // ready. The client never infers it from a cached value.
  const { data, isLoading, error } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authStatus,
    retry: false,
    staleTime: 0,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-content-muted">
        Loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm font-medium text-danger">Cannot reach the control plane.</p>
          <p className="mt-2 text-sm text-content-muted">
            Check that the process is running and reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (data.setupRequired) return <AuthPage setupRequired />;
  if (!data.authenticated) return <AuthPage setupRequired={false} />;

  return (
    <Routes>
      <Route element={<Layout admin={data.admin} />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectShell />}>
          <Route index element={<ProjectDetailPage />} />
          <Route path="data" element={<DataPage />} />
          <Route path="sql" element={<SqlPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="branches" element={<BranchesPage />} />
          <Route path="extensions" element={<ExtensionsPage />} />
          <Route path="upgrade" element={<UpgradePage />} />
          <Route path="api" element={<ApiPage />} />
        </Route>
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/instance" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}

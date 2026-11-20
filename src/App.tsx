import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { Layout } from './components/Layout';
import { ListsProvider } from './lib/useLists';
import { NickProvider } from './lib/nick';
import { Loading } from './components/ui';
import { LoginPage, RegisterPage, InvitePage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { ListPage } from './pages/Lists';
import { ChatPage } from './pages/Chat';
import { DataPage } from './pages/Data';
import { CalendarPage } from './pages/Calendar';
import { ConnectionsPage } from './pages/Connections';
import { NotificationsPage } from './pages/Notifications';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { ArchivePage } from './pages/Archive';
import { ReceiptPage } from './pages/Receipt';
import { BoardPage } from './pages/Board';
import { PlanPage } from './pages/Plan';
import { SharePage } from './pages/Share';

export function App() {
  const { session, loading } = useSession();
  const loc = useLocation();
  if (loading) return <div className="center-screen"><Loading /></div>;
  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="*" element={<Navigate to={`/login${loc.pathname !== '/' ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : ''}`} replace />} />
      </Routes>
    );
  }
  return (
    <ListsProvider><NickProvider>
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/lists/:slug" element={<ListPage />} />
        <Route path="/lists" element={<Navigate to="/lists/groceries" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/plan/:id" element={<PlanPage />} />
        <Route path="/share" element={<SharePage />} />
        <Route path="/data" element={<DataPage />} />
        {/* Old addresses from before the redesign */}
        <Route path="/me/*" element={<Navigate to="/lists/groceries" replace />} />
        <Route path="/us/*" element={<Navigate to="/lists/groceries" replace />} />
        <Route path="/you" element={<Navigate to="/chat" replace />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/calendar/connections" element={<ConnectionsPage />} />
        <Route path="/receipts/:id" element={<ReceiptPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="/invite/:token" element={<Navigate to="/" replace />} />
        <Route path="*" element={<div className="page"><h1>Not found</h1></div>} />
      </Routes>
    </Layout>
    </NickProvider></ListsProvider>
  );
}

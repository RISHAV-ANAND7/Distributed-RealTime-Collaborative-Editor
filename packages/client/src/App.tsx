import { Routes, Route } from 'react-router-dom';
import { AuthContext, useAuthState } from './hooks/useAuth';
import { DocumentList } from './components/DocumentList';
import { EditorPage } from './components/EditorPage';

function AuthProvider({ children }: { children: React.ReactNode }) {
  const authState = useAuthState();
  return (
    <AuthContext.Provider value={authState}>
      {children}
    </AuthContext.Provider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<DocumentList />} />
        <Route path="/doc/:id" element={<EditorPage />} />
      </Routes>
    </AuthProvider>
  );
}
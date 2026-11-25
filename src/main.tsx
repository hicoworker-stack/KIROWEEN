import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import { detectLang, setLang } from './ui/i18n';

setLang(detectLang());

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary scope="Aqua Sentinel">
    <App />
  </ErrorBoundary>
);

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ClipboardList, Home, LogOut, Map as MapIcon, Settings2, WifiOff } from 'lucide-react';
import { ROLE_LABEL, Role } from '../core/permissions';
import { SessionUser } from '../client/api';
import { MAIN_NAV, MainView, timeAgo } from '../ui/vocab';
import { ProvenanceBadge, StatusPill } from './ui';

const ICON: Record<Exclude<MainView, 'advanced'>, React.FC<{ className?: string }>> = { home: Home, map: MapIcon, incidents: AlertTriangle, orders: ClipboardList };

export interface ShellConnection {
  online: boolean;
  simulatedOffline: boolean;
  pendingReports: number;
  syncing: boolean;
  lastUpdatedAt: number | null;
}

interface AppShellProps {
  view: MainView;
  user: SessionUser;
  connection: ShellConnection;
  allSynthetic: boolean;
  badges: Partial<Record<Exclude<MainView, 'advanced'>, number>>;
  onNavigate: (v: MainView) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

/** Estado de la conexión en una palabra: qué pasa con mis datos. */
export const ConnectionChip: React.FC<{ c: ShellConnection }> = ({ c }) => {
  if (!c.online) {
    return <StatusPill tone="offline" label={c.pendingReports > 0 ? `Sin conexión · ${c.pendingReports} por enviar` : 'Sin conexión'} title="No hay conexión con el servidor. Lo que registres se guarda en este dispositivo." />;
  }
  if (c.syncing) return <StatusPill tone="attention" label="Enviando…" />;
  if (c.pendingReports > 0) return <StatusPill tone="attention" label={`${c.pendingReports} por enviar`} title="Hay reportes guardados en este dispositivo que aún no se enviaron." />;
  return <StatusPill tone="ok" label={c.lastUpdatedAt ? `Al día · ${timeAgo(c.lastUpdatedAt)}` : 'Conectado'} title="Conectado al servidor." />;
};

export const AppShell: React.FC<AppShellProps> = ({ view, user, connection, allSynthetic, badges, onNavigate, onLogout, children }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  // Al CAMBIAR de apartado el foco pasa al contenido (lectores de pantalla y teclado). Al cargar, no: así el primer Tab llega al salto de contenido.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  const NavButton = ({ id, label, mobile }: { id: Exclude<MainView, 'advanced'>; label: string; mobile?: boolean }) => {
    const Icon = ICON[id];
    const active = view === id;
    const badge = badges[id] ?? 0;
    return (
      <button
        type="button"
        onClick={() => onNavigate(id)}
        aria-current={active ? 'page' : undefined}
        className={
          mobile
            ? `relative flex min-h-14 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-xs font-medium ${active ? 'text-accent' : 'text-soft'}`
            : `relative inline-flex min-h-11 cursor-pointer items-center gap-2 border-b-2 px-3 text-sm font-medium ${active ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-ink'}`
        }
      >
        <Icon className={mobile ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden="true" />
        <span>{label}</span>
        {badge > 0 && (
          <span className={`${mobile ? 'absolute right-[22%] top-1.5' : ''} min-w-5 rounded-full bg-critical px-1.5 text-center text-[11px] font-bold leading-5 text-[#2A0610]`} aria-label={badge === 1 ? '1 pendiente' : `${badge} pendientes`}>
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <a href="#main" className="skip-link">
        Saltar al contenido
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-6">
            <button type="button" onClick={() => onNavigate('home')} className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2.5 font-display text-lg font-semibold tracking-tight text-ink" aria-label="Aqua Sentinel, ir al inicio">
              <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden="true" className="text-accent">
                <rect x="2" y="2" width="24" height="24" rx="6" stroke="currentColor" strokeWidth="1.6" />
                <path d="M14 7C14 7 9 13.2 9 16.5C9 19.26 11.24 21.5 14 21.5C16.76 21.5 19 19.26 19 16.5C19 13.2 14 7 14 7Z" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <span className="hidden sm:inline">Aqua Sentinel</span>
            </button>
            <nav aria-label="Secciones principales" className="hidden items-center gap-1 md:flex">
              {MAIN_NAV.map((n) => (
                <NavButton key={n.id} id={n.id} label={n.id === 'orders' ? 'Órdenes' : n.label} />
              ))}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {allSynthetic && (
              <span className="hidden sm:inline-flex">
                <ProvenanceBadge kind="simulado" />
              </span>
            )}
            <ConnectionChip c={connection} />
            <div className="relative" ref={menuRef}>
              <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Menú de ${user.displayName}`} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 text-sm text-soft hover:text-ink">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-raised text-xs font-bold text-accent" aria-hidden="true">
                  {user.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden max-w-[10rem] truncate lg:inline">{user.displayName}</span>
              </button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-xl shadow-black/40">
                  <div className="border-b border-line px-4 py-3">
                    <p className="truncate text-sm font-semibold text-ink">{user.displayName}</p>
                    <p className="text-xs text-quiet">
                      @{user.username} · {ROLE_LABEL[user.role as Role]}
                    </p>
                  </div>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onNavigate('advanced');
                    }}
                    className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 text-left text-sm text-soft hover:bg-raised hover:text-ink"
                  >
                    <Settings2 className="h-4 w-4" aria-hidden="true" /> Herramientas avanzadas
                  </button>
                  <button role="menuitem" type="button" onClick={onLogout} className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-t border-line px-4 text-left text-sm text-soft hover:bg-raised hover:text-ink">
                    <LogOut className="h-4 w-4" aria-hidden="true" /> Cerrar sesión
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-8 focus:outline-none md:pb-12">
        {!connection.online && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-offline/40 bg-offline/10 px-4 py-3 text-sm text-soft" role="status">
            <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-offline" aria-hidden="true" />
            <p>
              <strong className="text-ink">{connection.simulatedOffline ? 'Sin conexión (simulada).' : 'Sin conexión.'}</strong> Puedes seguir reportando problemas: se guardan en este dispositivo y se envían cuando vuelva la señal. Lo que ves puede estar desactualizado.
            </p>
          </div>
        )}
        <div key={view} className="view-in">
          {children}
        </div>
      </main>

      <nav aria-label="Secciones principales" className="pb-safe fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-canvas/95 backdrop-blur md:hidden">
        {MAIN_NAV.map((n) => (
          <NavButton key={n.id} id={n.id} label={n.id === 'orders' ? 'Órdenes' : n.label} mobile />
        ))}
      </nav>
    </div>
  );
};

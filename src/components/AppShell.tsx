import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ClipboardList, Home, LogIn, LogOut, Map as MapIcon, Menu as MenuIcon, Settings2, WifiOff } from 'lucide-react';
import { ROLE_LABEL } from '../core/permissions';
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
  /** Con sesión: cerrar sesión. Como visitante del modo público: ir a iniciar sesión. */
  onLogout?: () => void;
  /** Solo para pruebas: renderiza el menú abierto. */
  initialMenuOpen?: boolean;
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

const sectionLabel = (v: MainView) => (v === 'advanced' ? 'Herramientas avanzadas' : (MAIN_NAV.find((n) => n.id === v)?.label ?? 'Inicio'));

export const AppShell: React.FC<AppShellProps> = ({ view, user, connection, allSynthetic, badges, onNavigate, onLogout, initialMenuOpen = false, children }) => {
  const [open, setOpen] = useState(initialMenuOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const visitor = user.role === 'VISITOR';
  const alerts = (badges.incidents ?? 0) + (badges.orders ?? 0);

  const items = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  // Cierra al hacer clic fuera o al pulsar Escape; al abrir lleva el foco a la sección actual.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    const current = panelRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? items()[0];
    current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // Al CAMBIAR de apartado el foco pasa al contenido (lectores de pantalla y teclado). Al cargar, no: así el primer Tab llega al salto de contenido.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  const go = (v: MainView) => {
    setOpen(false);
    onNavigate(v);
  };
  const itemClass = (active: boolean) => `flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 text-left text-sm focus:outline-none focus-visible:bg-raised ${active ? 'bg-raised/70 text-accent' : 'text-soft hover:bg-raised hover:text-ink'}`;

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <a href="#main" className="skip-link">
        Saltar al contenido
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <button type="button" onClick={() => go('home')} className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2.5 font-display text-lg font-semibold tracking-tight text-ink" aria-label="Aqua Sentinel, ir al inicio">
            <img src="/images/logo-mark.png" alt="" width="40" height="40" className="h-10 w-10 object-contain" />
            <span className="hidden sm:inline">Aqua Sentinel</span>
          </button>

          <div className="flex min-w-0 shrink-0 items-center gap-2">
            {allSynthetic && (
              <span className="hidden sm:inline-flex">
                <ProvenanceBadge kind="simulado" />
              </span>
            )}
            <ConnectionChip c={connection} />
            <div className="relative" ref={wrapRef}>
              <button
                ref={buttonRef}
                type="button"
                id="main-menu-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls="main-menu"
                aria-label={`Menú de navegación. Estás en ${sectionLabel(view)}`}
                onClick={() => setOpen((o) => !o)}
                className="relative flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-raised"
              >
                <MenuIcon className="h-4 w-4" aria-hidden="true" />
                <span>Menú</span>
                <span className="hidden max-w-[9rem] truncate text-soft sm:inline">· {sectionLabel(view)}</span>
                <ChevronDown className={`h-4 w-4 text-quiet transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                {alerts > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-canvas bg-critical" />}
              </button>

              {open && (
                <div
                  ref={panelRef}
                  id="main-menu"
                  role="menu"
                  aria-labelledby="main-menu-button"
                  onKeyDown={onMenuKey}
                  className="view-in absolute right-0 top-full z-40 mt-2 w-[min(18.5rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line-strong bg-surface shadow-xl shadow-black/40"
                >
                  <div className="border-b border-line px-4 py-3">
                    <p className="truncate text-sm font-semibold text-ink">{user.displayName}</p>
                    <p className="text-xs text-quiet">{visitor ? 'Modo público · solo lectura' : onLogout ? `@${user.username} · ${ROLE_LABEL[user.role]}` : 'Acceso libre'}</p>
                  </div>
                  {MAIN_NAV.map((n) => {
                    const Icon = ICON[n.id];
                    const badge = badges[n.id] ?? 0;
                    return (
                      <button key={n.id} role="menuitem" type="button" tabIndex={-1} aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)} className={itemClass(view === n.id)}>
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="flex-1">{n.label}</span>
                        {badge > 0 && (
                          <span className="min-w-5 rounded-full bg-critical px-1.5 text-center text-[11px] font-bold leading-5 text-[#2A0610]" aria-label={badge === 1 ? '1 pendiente' : `${badge} pendientes`}>
                            {badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <div className="border-t border-line" role="none">
                    <button role="menuitem" type="button" tabIndex={-1} aria-current={view === 'advanced' ? 'page' : undefined} onClick={() => go('advanced')} className={itemClass(view === 'advanced')}>
                      <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" /> Herramientas avanzadas
                    </button>
                  </div>
                  {onLogout && (
                    <div className="border-t border-line" role="none">
                      <button
                        role="menuitem"
                        type="button"
                        tabIndex={-1}
                        onClick={() => {
                          setOpen(false);
                          onLogout();
                        }}
                        className={itemClass(false)}
                      >
                        {visitor ? <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" /> : <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        {visitor ? 'Iniciar sesión' : 'Cerrar sesión'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {visitor && (
          <div role="note" className="border-t border-line bg-surface/70">
            <p className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-soft">
              <span className="font-semibold text-ink">Modo público de demostración.</span>
              <span>Datos simulados y solo lectura: nada de lo que veas modifica información real.</span>
              <button type="button" onClick={onLogout} className="-my-2 min-h-11 cursor-pointer font-semibold text-accent underline">
                Iniciar sesión para actuar
              </button>
            </p>
          </div>
        )}
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8 focus:outline-none">
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
    </div>
  );
};

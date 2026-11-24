import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthStatus, fetchAuthStatus, loginRequest, logoutRequest, SessionUser, setupRequest, setUnauthorizedHandler } from './api';
import { setPasswordPrompter } from './adminFetch';

/**
 * Puerta de acceso: sin sesión solo se muestra el inicio de sesión (o la configuración inicial). La interfaz oculta
 * lo que el rol no puede hacer, pero la decisión real siempre la toma el servidor.
 */
export interface Session {
  user: SessionUser;
  /** Con sesión: cierra la sesión. Como visitante del modo público: abre el inicio de sesión. */
  logout?: () => void;
  /** Visitante anónimo del modo público (solo lectura, sin cuenta). */
  visitor: boolean;
}

/** Identidad de presentación del visitante: no existe en el servidor y no concede ningún permiso por sí misma. */
export const VISITOR_USER: SessionUser = { id: 'public-visitor', username: 'visitante', displayName: 'Visitante', role: 'VISITOR' };

const field = 'w-full rounded-md bg-[#0A1F2D] border border-[#18364A] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400';
const button = 'w-full rounded-md bg-cyan-500 hover:bg-cyan-400 text-[#041018] font-semibold text-sm py-2 disabled:opacity-50 cursor-pointer';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06131C] text-[#E6F1F5] px-4">
      <div className="w-full max-w-sm rounded-xl border border-[#18364A] bg-[#08202E] p-6 space-y-4">
        <img src="/images/logo-mark.png" alt="" width="56" height="56" className="h-14 w-14 object-contain" />
        <h1 className="text-lg font-semibold text-cyan-300">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function LoginForm({ status, onDone, onBack }: { status: AuthStatus; onDone: (s: AuthStatus) => void; onBack?: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'setup'>(status.setupAvailable && status.needsAdmin ? 'setup' : 'login');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = mode === 'setup' ? await setupRequest({ code, username, displayName, password }) : await loginRequest(username, password);
      if (r.ok) {
        setPassword('');
        onDone(await fetchAuthStatus());
      } else {
        setError(typeof r.data.error === 'string' ? r.data.error : 'No se pudo iniciar sesión.');
        if (r.status === 403 && r.data.code === 'csrf') await fetchAuthStatus();
      }
    } catch {
      setError('No se pudo contactar con el servidor.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={mode === 'setup' ? 'Crear el primer administrador' : 'Aqua Sentinel · Iniciar sesión'}>
      {status.needsAdmin && !status.setupAvailable && (
        <p className="text-xs text-amber-300">
          No hay usuarios. Un administrador del servidor debe crear el primero con <span className="font-mono">npm run auth -- create-admin &lt;usuario&gt;</span>.
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        {mode === 'setup' && (
          <>
            <label className="block text-xs text-slate-400">
              Código de un solo uso (mostrado en la consola del servidor)
              <input className={`${field} font-mono`} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
            </label>
            <label className="block text-xs text-slate-400">
              Nombre visible
              <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
            </label>
          </>
        )}
        <label className="block text-xs text-slate-400">
          Usuario
          <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label className="block text-xs text-slate-400">
          Contraseña
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} required />
        </label>
        {mode === 'setup' && <p className="text-[11px] text-slate-500">Mínimo 12 caracteres; usa al menos 3 tipos de carácter o 16 o más.</p>}
        {error && (
          <p role="alert" className="text-xs text-rose-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={button}>
          {busy ? 'Un momento…' : mode === 'setup' ? 'Crear administrador' : 'Entrar'}
        </button>
      </form>
      {onBack && (
        <button type="button" className="min-h-11 text-sm text-cyan-300 underline cursor-pointer" onClick={onBack}>
          Volver a la demostración pública
        </button>
      )}
      {status.setupAvailable && (
        <button type="button" className="text-xs text-cyan-300 underline cursor-pointer" onClick={() => setMode(mode === 'setup' ? 'login' : 'setup')}>
          {mode === 'setup' ? 'Ya tengo una cuenta' : 'Configuración inicial'}
        </button>
      )}
    </Card>
  );
}

function PasswordDialog({ message, onResult }: { message: string; onResult: (v: string | null) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-label="Confirmar contraseña">
      <form
        className="w-full max-w-sm rounded-xl border border-[#18364A] bg-[#08202E] p-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onResult(value);
        }}
      >
        <p className="text-sm text-slate-200">{message}</p>
        <input className={field} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="current-password" autoFocus required />
        <div className="flex gap-2">
          <button type="button" className="flex-1 rounded-md border border-[#18364A] text-slate-300 text-sm py-2 cursor-pointer" onClick={() => onResult(null)}>
            Cancelar
          </button>
          <button type="submit" className="flex-1 rounded-md bg-cyan-500 text-[#041018] font-semibold text-sm py-2 cursor-pointer">
            Confirmar
          </button>
        </div>
      </form>
    </div>
  );
}

export function AuthGate({ children }: { children: (session: Session) => React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ message: string; resolve: (v: string | null) => void } | null>(null);
  const [wantLogin, setWantLogin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      let s = await fetchAuthStatus();
      // Acceso libre: si la sesión de invitado caducó, el servidor abre otra al consultar el estado.
      if (s.openAccess && !s.authenticated) s = await fetchAuthStatus();
      setStatus(s);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // Acceso libre: si la sesión de invitado caduca (401), se pide otra, con un tope de intentos para no entrar en bucle.
  const retries = useRef(0);
  useEffect(() => {
    if (!status?.openAccess) return;
    if (status.authenticated) {
      retries.current = 0;
    } else if (retries.current < 3) {
      retries.current += 1;
      void refresh();
    }
  }, [status, refresh]);
  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => setStatus((s) => (s && s.authenticated ? { ...s, authenticated: false, user: null } : s)));
    // (con acceso libre, el efecto de abajo vuelve a pedir la sesión de invitado)
    setPasswordPrompter((message) => new Promise((resolve) => setDialog({ message, resolve })));
    return () => {
      setUnauthorizedHandler(null);
      setPasswordPrompter(null);
    };
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest();
    await refresh();
  }, [refresh]);

  if (failed) {
    return (
      <Card title="Aqua Sentinel">
        <p className="text-sm text-slate-300">No se pudo contactar con el servidor.</p>
        <button className={button} onClick={() => void refresh()}>
          Reintentar
        </button>
      </Card>
    );
  }
  if (!status) return <Card title="Aqua Sentinel"><p className="text-sm text-slate-400">Comprobando sesión…</p></Card>;
  if (status.openAccess && (!status.authenticated || !status.user)) {
    return (
      <Card title="Aqua Sentinel">
        <p className="text-sm text-slate-400">{retries.current >= 3 ? 'No se pudo abrir la sesión de invitado.' : 'Abriendo…'}</p>
        {retries.current >= 3 && (
          <button className={button} onClick={() => { retries.current = 0; void refresh(); }}>
            Reintentar
          </button>
        )}
      </Card>
    );
  }
  if (!status.authenticated || !status.user) {
    // MODO PÚBLICO: se entra directamente como visitante (solo lectura). El inicio de sesión sigue disponible desde el menú.
    if (status.publicMode && !wantLogin) return <>{children({ user: VISITOR_USER, visitor: true, logout: () => setWantLogin(true) })}</>;
    return (
      <LoginForm
        key={String(status.csrfToken)}
        status={status}
        onBack={status.publicMode ? () => setWantLogin(false) : undefined}
        onDone={(s) => {
          setWantLogin(false);
          setStatus(s);
        }}
      />
    );
  }
  return (
    <>
      {children({ user: status.user, visitor: false, logout: status.openAccess ? undefined : () => void logout() })}
      {dialog && (
        <PasswordDialog
          message={dialog.message}
          onResult={(v) => {
            dialog.resolve(v);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

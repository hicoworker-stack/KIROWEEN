import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * REQ-RES-08: un dato inesperado en un componente ya no deja la interfaz en blanco.
 * El límite muestra qué falló, permite reintentar y, si el problema es el estado del servidor, indica cómo recuperarlo.
 */

interface Props {
  children: React.ReactNode;
  /** Nombre de la zona protegida, para el mensaje. */
  scope?: string;
  /** Cambiar este valor reinicia el límite (p. ej. al navegar a otra vista). */
  resetKey?: unknown;
}
interface State {
  error: Error | null;
}

export function describeRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.scope ?? 'app'}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="m-4 p-5 rounded-xl border border-rose-500/50 bg-[#2A0B14] text-rose-100 space-y-3 max-w-2xl">
        <div className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {this.props.scope ? `Error al mostrar «${this.props.scope}»` : 'Error inesperado en la aplicación'}
        </div>
        <p className="text-xs leading-relaxed break-words">{describeRenderError(this.state.error)}</p>
        <p className="text-xs text-rose-200/80 leading-relaxed">
          Los datos del servidor no se perdieron. Si el error persiste tras reintentar, puede haber un dato corrupto en el estado:
          reinicia la demostración o restaura un snapshot desde «Offline e Integraciones».
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-rose-500 hover:bg-rose-400 text-[#2A0B14] rounded-lg cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reintentar
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-xs font-medium border border-rose-400/60 text-rose-100 rounded-lg cursor-pointer"
          >
            Recargar la página
          </button>
        </div>
      </div>
    );
  }
}

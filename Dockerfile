# Instancia PÚBLICA de demostración de Aqua Sentinel (solo lectura, datos simulados, spec 10).
# El proveedor (Render, Railway, Fly.io...) termina HTTPS delante del contenedor.
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
# Incluye las dependencias de desarrollo: el servidor se ejecuta con tsx y la interfaz se compila con Vite.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    AQUA_PUBLIC_MODE=1
# Obligatorias en producción, con el dominio real del despliegue (sin ellas el servidor no arranca):
#   AQUA_ALLOWED_HOSTS=aqua-sentinel.onrender.com
#   AQUA_ALLOWED_ORIGINS=https://aqua-sentinel.onrender.com
EXPOSE 8080
# El proceso corre sin privilegios (USER node) y escribe estado, clave de sellado, usuarios y auditoría bajo /app/data.
# 'data' está excluida por .dockerignore, así que se crea aquí y se entrega al usuario node; sin esto no podría escribirla.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
CMD ["npx", "tsx", "server.ts", "--public"]

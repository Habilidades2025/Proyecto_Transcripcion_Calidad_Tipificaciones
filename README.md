# IA Analista de Calidad (OpenAI + Deepgram)

Flujo: subes **audios** → el backend **transcribe** (OpenAI o Deepgram) → **analiza** la llamada por tipificación (Novación, Propuesta de pago, Abono, Acuerdo a cuotas) → devuelve **JSON de auditoría** con **consolidado** (nota 100/0, ítems y críticos) → guarda histórico → UI web para revisar y exportar.

> **No se usa Faster-Whisper ni Python.** Todo es Node.js + APIs de OpenAI/Deepgram.

---

## Requisitos

- **Node.js 18+** (recomendado 20+).
- Cuenta/keys de:
  - **OpenAI** (para análisis + opcionalmente transcripción *Whisper*).
  - **Deepgram** (opción alternativa de transcripción).
- Conexión a internet para consumir las APIs.

---

## Instalación

```bash
# 1) Clonar e instalar
npm install

# 2) Configurar variables de entorno
cp .env.example .env
# (edita .env con tus API keys y límites)

# 3) Iniciar en modo desarrollo
npm run dev
# Abre: http://127.0.0.1:3000/

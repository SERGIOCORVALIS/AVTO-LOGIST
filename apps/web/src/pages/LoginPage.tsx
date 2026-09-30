import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { LoginScene } from "../scenes/LoginScene";
import { homePath, useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Button, Field, inputClass } from "../components/ui";

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("director@transinvest.local");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<"director" | "manager">("director");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function applyHint(role: "director" | "manager") {
    setHint(role);
    setEmail(
      role === "director"
        ? "director@transinvest.local"
        : "manager@transinvest.local"
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await login(email, password);
      nav(homePath(user.role), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden min-h-[420px] lg:block">
        <LoginScene />
        <div className="pointer-events-none absolute inset-x-0 bottom-8 text-center">
          <p className="font-serif text-xs tracking-[0.35em] text-gold-300">
            ДОСТАВИМ ТУДА, КУДА ДРУГИМ НЕ ПОД СИЛУ
          </p>
        </div>
      </div>
      <div className="flex items-center justify-center p-8">
        <motion.form
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md rounded-3xl border border-gold-500/30 bg-navy-900/80 p-8 shadow-gold"
        >
          <img
            src="/brand/logo.png"
            alt="TRANSINVEST"
            className="mx-auto mb-4 h-24 w-24 object-contain"
          />
          <h1 className="text-center font-serif text-3xl tracking-[0.2em] text-gold-300">
            TRANSINVEST
          </h1>
          <p className="mt-2 text-center text-sm text-white/60">
            Кабинет управления логистическим роботом. Роль откроется по вашей учётке.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2">
            {(["director", "manager"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => applyHint(r)}
                className={`rounded-lg border px-3 py-2 text-xs uppercase tracking-wider ${
                  hint === r
                    ? "border-gold-400 bg-gold-500/15 text-gold-300"
                    : "border-white/10 text-white/50"
                }`}
              >
                {r === "director" ? "Руководитель" : "Менеджер"}
              </button>
            ))}
          </div>
          <div className="mt-6 space-y-4">
            <Field label="Email" hint="Подсказка роли только заполняет поле. Фактический кабинет зависит от учётки.">
              <input
                className={inputClass()}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label="Пароль">
              <input
                className={inputClass()}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
          </div>
          {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}
          <div className="mt-6">
            <Button type="submit" disabled={busy}>
              {busy ? "Входим…" : "Войти в кабинет"}
            </Button>
          </div>
        </motion.form>
      </div>
    </div>
  );
}

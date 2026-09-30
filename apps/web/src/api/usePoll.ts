import { useEffect, useState } from "react";

export function usePoll<T>(fn: () => Promise<T>, ms = 7000): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      try {
        const v = await fn();
        if (on) setData(v);
      } catch {
        /* keep last */
      }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [fn, ms]);
  return data;
}

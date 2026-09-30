import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import { PIPELINE, STATUS_LABELS } from "../api/types";

function Core({ active }: { active: string[] }) {
  const ref = useRef<Group>(null);
  useFrame((_, d) => {
    if (ref.current) ref.current.rotation.y += d * 0.35;
  });
  const nodes = useMemo(() => {
    const r = 1.35;
    return PIPELINE.map((id, i) => {
      const a = (i / PIPELINE.length) * Math.PI * 2 - Math.PI / 2;
      return { id, x: Math.cos(a) * r, z: Math.sin(a) * r };
    });
  }, []);
  return (
    <group ref={ref}>
      <mesh>
        <icosahedronGeometry args={[0.42, 1]} />
        <meshStandardMaterial
          color="#C9A227"
          metalness={0.95}
          roughness={0.2}
          emissive="#5a4308"
          emissiveIntensity={0.4}
        />
      </mesh>
      {nodes.map((n) => {
        const on = active.includes(n.id);
        return (
          <mesh key={n.id} position={[n.x, 0, n.z]}>
            <sphereGeometry args={[on ? 0.12 : 0.08, 16, 16]} />
            <meshStandardMaterial
              color={on ? "#E8D48B" : "#1B3A7A"}
              emissive={on ? "#C9A227" : "#0B1A33"}
              emissiveIntensity={on ? 0.8 : 0.1}
              metalness={0.7}
              roughness={0.3}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export function RobotCore({
  byStatus,
}: {
  byStatus: Array<{ status: string; n: number }>;
}) {
  const active = byStatus.filter((s) => s.n > 0).map((s) => s.status);
  const top = [...byStatus].sort((a, b) => b.n - a.n)[0];
  return (
    <div className="relative h-64 overflow-hidden rounded-2xl border border-gold-500/30 bg-navy-950 shadow-gold">
      <Canvas camera={{ position: [0, 1.4, 3.2], fov: 45 }} dpr={[1, 1.5]}>
        <ambientLight intensity={0.4} />
        <pointLight position={[2, 2, 2]} color="#C9A227" intensity={18} />
        <pointLight position={[-2, 1, -1]} color="#1B3A7A" intensity={12} />
        <Core active={active} />
      </Canvas>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-navy-950 to-transparent p-4">
        <p className="font-serif text-sm tracking-[0.2em] text-gold-300">ЯДРО РОБОТА</p>
        <p className="text-xs text-white/70">
          Активный контур:{" "}
          {top ? `${STATUS_LABELS[top.status] || top.status} · ${top.n}` : "нет сделок"}
        </p>
      </div>
    </div>
  );
}

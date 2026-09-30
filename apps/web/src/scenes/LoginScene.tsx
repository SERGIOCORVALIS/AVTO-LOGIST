import { Canvas, useFrame } from "@react-three/fiber";
import { Float, OrbitControls, Sparkles } from "@react-three/drei";
import { useRef } from "react";
import type { Group, Mesh } from "three";
import * as THREE from "three";

function Emblem() {
  const group = useRef<Group>(null);
  const hook = useRef<Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (group.current) {
      group.current.rotation.y = Math.sin(t * 0.25) * 0.35;
      group.current.position.y = Math.sin(t * 0.8) * 0.08;
    }
    if (hook.current) hook.current.position.y = 1.55 + Math.sin(t * 1.4) * 0.08;
  });
  return (
    <group ref={group}>
      <mesh position={[0, 0.15, 0]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[1.15, 1.15, 0.12, 6]} />
        <meshStandardMaterial
          color="#C9A227"
          metalness={0.95}
          roughness={0.22}
          emissive="#3a2c08"
        />
      </mesh>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.98, 0.98, 0.14, 6]} />
        <meshStandardMaterial color="#0B1A33" metalness={0.6} roughness={0.35} />
      </mesh>
      <Float speed={1.4} rotationIntensity={0.15} floatIntensity={0.2}>
        <mesh position={[0, 0.22, 0.08]}>
          <boxGeometry args={[0.72, 0.42, 0.42]} />
          <meshStandardMaterial
            color="#1B3A7A"
            metalness={0.55}
            roughness={0.3}
          />
        </mesh>
        <mesh position={[0, 0.22, 0.3]}>
          <boxGeometry args={[0.74, 0.44, 0.02]} />
          <meshStandardMaterial color="#C9A227" metalness={0.9} roughness={0.2} />
        </mesh>
      </Float>
      <mesh ref={hook} position={[0, 1.55, 0]}>
        <torusGeometry args={[0.16, 0.035, 12, 24, Math.PI]} />
        <meshStandardMaterial color="#E8D48B" metalness={1} roughness={0.15} />
      </mesh>
      <mesh position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.7, 8]} />
        <meshStandardMaterial color="#C9A227" metalness={1} roughness={0.2} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.15, 0]}>
        <torusGeometry args={[1.55, 0.025, 8, 64]} />
        <meshStandardMaterial color="#C9A227" metalness={0.9} roughness={0.25} />
      </mesh>
    </group>
  );
}

export function LoginScene() {
  return (
    <Canvas
      camera={{ position: [0, 0.4, 5.2], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
    >
      <color attach="background" args={["#070e1c"]} />
      <fog attach="fog" args={["#070e1c", 6, 14]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[4, 3, 4]} intensity={40} color="#C9A227" distance={18} />
      <pointLight position={[-4, -1, 2]} intensity={25} color="#1B3A7A" distance={16} />
      <spotLight
        position={[0, 6, 2]}
        angle={0.4}
        penumbra={0.6}
        intensity={30}
        color="#E8D48B"
      />
      <Sparkles count={90} scale={[10, 6, 8]} size={2.2} color="#C9A227" speed={0.4} />
      <Emblem />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        autoRotate
        autoRotateSpeed={0.6}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={Math.PI / 1.7}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.6, 0]}>
        <circleGeometry args={[4, 48]} />
        <meshStandardMaterial
          color="#0B1A33"
          metalness={0.4}
          roughness={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>
    </Canvas>
  );
}

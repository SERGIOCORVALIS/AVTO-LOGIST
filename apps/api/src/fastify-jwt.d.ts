import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      email: string;
      role: "director" | "manager";
      name: string;
    };
  }
}

export {};

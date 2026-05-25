export interface JWTPayload {
  discordUserId: string;
  agentName: string;
  avatar: string | null;
  iat: number;
  exp: number;
}

export interface Session {
  id: string;
  discordUserId: string;
  agentName: string;
  status: 'active' | 'ended';
  startedAt: Date;
  endedAt: Date | null;
}

export interface TranscriptTurn {
  speaker: 'agente' | 'cliente';
  text: string;
  timestamp: number;
  channel: 0 | 1;
}

export interface DashboardUser {
  sub: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: JWTPayload;
    dashboardUser: DashboardUser;
  }
}

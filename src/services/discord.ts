import axios from 'axios';
import { config } from '../config';

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}

interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

export async function exchangeCode(code: string): Promise<{
  user: DiscordUser;
  guilds: { id: string }[];
}> {
  const tokenRes = await axios.post<DiscordTokenResponse>(
    'https://discord.com/api/oauth2/token',
    new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.DISCORD_REDIRECT_URI,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const accessToken = tokenRes.data.access_token;
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const [userRes, guildsRes] = await Promise.all([
    axios.get<DiscordUser>('https://discord.com/api/users/@me', { headers: authHeader }),
    axios.get<{ id: string }[]>('https://discord.com/api/users/@me/guilds', { headers: authHeader }),
  ]);

  return { user: userRes.data, guilds: guildsRes.data };
}

export function isMember(guilds: { id: string }[]): boolean {
  return guilds.some((g) => g.id === config.DISCORD_GUILD_ID);
}

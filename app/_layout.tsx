import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import superjson from 'superjson';
import Constants from 'expo-constants';
import { trpc } from '@/lib/trpc';

const SERVER_URL = Constants.expoConfig?.extra?.serverUrl ?? 'https://jtpowerbot-jgpei7xw.manus.space';

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 30_000,
      },
    },
  }));

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${SERVER_URL}/api/trpc`,
          transformer: superjson,
        }),
      ],
    })
  );

  // 앱 시작 시 저장된 자격증명을 서버에 자동 동기화
  useEffect(() => {
    const syncCredentials = async () => {
      try {
        const stored = await AsyncStorage.getItem('bot_credentials');
        if (!stored) return;
        const creds = JSON.parse(stored);
        if (!creds?.apiKey || !creds?.secretKey) return;

        await fetch(`${SERVER_URL}/api/trpc/bot.setCredentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            json: {
              apiKey: creds.apiKey,
              secretKey: creds.secretKey,
              isTestnet: creds.isTestnet ?? false,
            },
          }),
        });
      } catch {
        // 서버 미연결 시 무시
      }
    };
    syncCredentials();
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </SafeAreaProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

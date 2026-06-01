import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const bottomPad = Platform.OS === 'web' ? 12 : Math.max(insets.bottom, 8);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#00D4AA',
        tabBarInactiveTintColor: '#687076',
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          paddingTop: 8,
          paddingBottom: bottomPad,
          height: 56 + bottomPad,
          backgroundColor: '#0D1117',
          borderTopColor: '#21262D',
          borderTopWidth: 0.5,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '분석',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="chart.bar.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="bot"
        options={{
          title: '자동봇',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="bolt.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trade-history"
        options={{
          title: '매매기록',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="list.bullet.rectangle.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '설정',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="gearshape.fill" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

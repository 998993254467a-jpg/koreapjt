import React from 'react';
import { View, ViewStyle, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface ScreenContainerProps {
  children: React.ReactNode;
  containerClassName?: string;
  style?: ViewStyle;
}

export function ScreenContainer({ children, style }: ScreenContainerProps) {
  return (
    <SafeAreaView style={[styles.container, style]} edges={['top', 'left', 'right']}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D1117',
  },
});

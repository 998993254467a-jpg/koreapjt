import React from 'react';
import { View } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MiniChartProps {
  candles: CandleData[];
  width?: number;
  height?: number;
}

export function MiniChart({ candles, width = 320, height = 120 }: MiniChartProps) {
  if (!candles || candles.length === 0) return null;

  const data = candles.slice(-60);
  const highs = data.map((c) => c.high);
  const lows = data.map((c) => c.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const priceRange = maxPrice - minPrice || 1;

  const padding = { top: 8, bottom: 8, left: 4, right: 4 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const candleWidth = Math.max(2, chartWidth / data.length - 1);

  const toY = (price: number) =>
    padding.top + ((maxPrice - price) / priceRange) * chartHeight;

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        {data.map((candle, i) => {
          const x = padding.left + i * (chartWidth / data.length) + candleWidth / 4;
          const isUp = candle.close >= candle.open;
          const color = isUp ? '#3FB950' : '#F85149';
          const bodyTop = toY(Math.max(candle.open, candle.close));
          const bodyBottom = toY(Math.min(candle.open, candle.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);
          const wickX = x + candleWidth / 2;

          return (
            <React.Fragment key={i}>
              {/* 위 꼬리 */}
              <Line
                x1={wickX}
                y1={toY(candle.high)}
                x2={wickX}
                y2={bodyTop}
                stroke={color}
                strokeWidth={1}
              />
              {/* 몸통 */}
              <Rect
                x={x}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={color}
                opacity={0.9}
              />
              {/* 아래 꼬리 */}
              <Line
                x1={wickX}
                y1={bodyBottom}
                x2={wickX}
                y2={toY(candle.low)}
                stroke={color}
                strokeWidth={1}
              />
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

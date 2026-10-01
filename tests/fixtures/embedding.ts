export const testEmbeddings = (count: number, dimensions = 4096): number[][] =>
  Array.from({ length: count }, () =>
    Array.from({ length: dimensions }, (_, i) => ((i % 19) - 9) / 100),
  );

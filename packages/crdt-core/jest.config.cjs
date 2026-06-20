module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: [],
  globals: {
    'ts-jest': {
      tsconfig: './tsconfig.jest.json',
      useESM: false,
    },
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

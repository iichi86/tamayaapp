import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DemoData, StorageAdapter } from '../domain/types';
import { validateDemoData } from './validate';

export const DEMO_STORAGE_KEY = '@tamaya/demo/v1';

export const asyncStorageAdapter: StorageAdapter = {
  async read() {
    const serialized = await AsyncStorage.getItem(DEMO_STORAGE_KEY);
    return serialized === null ? null : validateDemoData(JSON.parse(serialized));
  },
  async write(data) {
    await AsyncStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data));
  },
};

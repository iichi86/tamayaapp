import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { clientConfiguration } from './config';
import { createFirebaseAuth } from './firebaseAuth';
import { createProductionApi } from './apiClient';

export function createProductionRuntime() {
  const config = clientConfiguration();
  const auth = createFirebaseAuth(config);
  const api = createProductionApi({
    baseUrl: config.apiUrl, storeId: config.storeId, auth,
    randomId: () => Crypto.randomUUID(),
    fingerprint: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
    journal: { get: AsyncStorage.getItem, set: AsyncStorage.setItem, remove: AsyncStorage.removeItem },
  });
  return { auth, api };
}

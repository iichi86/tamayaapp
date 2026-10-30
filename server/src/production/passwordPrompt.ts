import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ProductionConfigurationError } from './config.js';

/** Read locally without echoing the owner password or adding it to shell history. */
export async function promptDatabasePassword(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new ProductionConfigurationError('DBパスワードの非表示入力には対話型ターミナルが必要です。PCのコマンド画面で実行するか、管理用接続情報を非公開のローカル設定へ登録してください。');
  }
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input, output: silent, terminal: true, historySize: 0 });
  output.write('SupabaseのDBパスワードを入力してください（表示されません）: ');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (password?: string) => {
      if (settled) return;
      settled = true;
      terminal.close();
      silent.end();
      output.write('\n');
      if (password) resolve(password);
      else reject(new ProductionConfigurationError('DBパスワードが入力されなかったため、接続せずに終了しました。'));
    };
    terminal.on('SIGINT', () => finish());
    terminal.on('close', () => finish());
    terminal.question('', finish);
  });
}

/** Replace only the password placeholder, keeping the supplied password in memory. */
export async function resolveDatabasePasswordPlaceholder(env: NodeJS.ProcessEnv = process.env, loadPassword: () => Promise<string> = promptDatabasePassword): Promise<NodeJS.ProcessEnv> {
  const key = env.DATABASE_MIGRATION_URL?.trim() ? 'DATABASE_MIGRATION_URL' : 'DATABASE_URL';
  const value = env[key];
  if (!value?.includes('[YOUR-PASSWORD]')) return env;
  let database: URL;
  try {
    database = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)
      || decodeURIComponent(database.password) !== '[YOUR-PASSWORD]') throw new Error('Invalid placeholder');
  } catch {
    throw new ProductionConfigurationError('DB接続情報の[YOUR-PASSWORD]はパスワード欄にだけ指定してください。');
  }
  const password = await loadPassword();
  if (!password || /[\r\n]/.test(password)) throw new ProductionConfigurationError('DBパスワードを確認してください。接続情報は保存していません。');
  database.password = encodeURIComponent(password);
  return { ...env, [key]: database.toString() };
}

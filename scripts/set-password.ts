import { AuthManager } from '../src/core/auth';

const username = process.argv[2] || 'admin';
const password = process.argv[3] || 'admin';

const auth = new AuthManager();
const user = auth.getUser(username);

if (user) {
  auth.setPassword(username, password);
  console.log(`Password updated for user '${username}'.`);
} else {
  auth.register(username, password);
  console.log(`User '${username}' registered.`);
}

console.log(`Credentials: Username: ${username} | Password: ${password}`);

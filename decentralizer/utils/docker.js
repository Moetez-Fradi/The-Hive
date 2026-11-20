import Docker from "dockerode";
import axios from "axios";

const docker = new Docker();

async function imageExistsLocally(image) {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(image) {
  if (await imageExistsLocally(image)) return;
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

export async function waitForReady(baseUrl, timeoutMs = 60000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await axios.get(baseUrl, { timeout: 2000, validateStatus: () => true });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return false;
}

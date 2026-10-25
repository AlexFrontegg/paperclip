import { pathToFileURL } from "node:url";

// Require an existing destination with deliberate visibility. A push to an
// absent Docker Hub repository must not implicitly create a public repository.
export async function checkDockerHubRepository({ image, visibility, username, token }, request = fetch) {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(image ?? "")) {
    throw new Error("DOCKERHUB_IMAGE must be a Docker Hub namespace/repository, without registry or tag");
  }
  if (!["private", "public"].includes(visibility)) throw new Error("DOCKERHUB_VISIBILITY must be private or public");
  if (!username || !token) throw new Error("Docker Hub publishing credentials are missing");
  const call = async (path, options) => {
    const response = await request(`https://hub.docker.com${path}`, {
      ...options, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    // Do not include response bodies: authentication errors can echo credentials.
    if (!response.ok) throw new Error(`Docker Hub destination check failed (HTTP ${response.status}); check credentials and create ${image} with ${visibility} visibility before publishing`);
    try {
      return await response.json();
    } catch {
      throw new Error("Docker Hub returned an invalid JSON response");
    }
  };
  const auth = await call("/v2/auth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: username, secret: token }),
  });
  if (typeof auth.access_token !== "string" || !auth.access_token) throw new Error("Docker Hub returned no access token");
  const [namespace, repository] = image.split("/");
  const info = await call(`/v2/namespaces/${namespace}/repositories/${repository}`, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
  });
  if (info.namespace !== namespace || info.name !== repository) throw new Error("Docker Hub returned a different repository");
  if (info.is_private !== (visibility === "private")) throw new Error(`Docker Hub ${image} visibility does not match DOCKERHUB_VISIBILITY=${visibility}`);
  if (info.permissions?.write !== true) throw new Error(`Docker Hub credentials cannot push to ${image}`);
  return { image, visibility };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkDockerHubRepository({
      image: process.env.DOCKERHUB_IMAGE,
      visibility: process.env.DOCKERHUB_VISIBILITY ?? "private",
      username: process.env.DOCKERHUB_USERNAME,
      token: process.env.DOCKERHUB_TOKEN,
    });
    console.log(`Docker Hub destination verified: ${result.image} (${result.visibility})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

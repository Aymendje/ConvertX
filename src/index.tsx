import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import cookie from "@elysiajs/cookie";
import { html } from "@elysiajs/html";
import { jwt } from "@elysiajs/jwt";
import { staticPlugin } from "@elysiajs/static";
import { Elysia, t } from "elysia";
import { BaseHtml } from "./components/base";
import { Header } from "./components/header";
import {
  getAllInputs,
  getAllTargets,
  getPossibleTargets,
  mainConverter,
} from "./converters/main";
import {
  normalizeFiletype,
  normalizeOutputFiletype,
} from "./helpers/normalizeFiletype";

const db = new Database("./data/mydb.sqlite", { create: true });
const uploadsDir = "./data/uploads/";
const outputDir = "./data/output/";

const ACCOUNT_REGISTRATION =
  process.env.ACCOUNT_REGISTRATION === "true" || false;

// fileNames: fileNames,
// filesToConvert: fileNames.length,
// convertedFiles : 0,
// outputFiles: [],

// init db
db.exec(`
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email TEXT NOT NULL,
	password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  output_file_name TEXT NOT NULL,
  status TEXT DEFAULT 'not started',
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS jobs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	date_created TEXT NOT NULL,
  status TEXT DEFAULT 'not started',
  num_files INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);`);

const dbVersion = (
  db.query("PRAGMA user_version").get() as { user_version?: number }
).user_version;
if (dbVersion === 0) {
  db.exec(
    "ALTER TABLE file_names ADD COLUMN status TEXT DEFAULT 'not started';",
  );
  db.exec("PRAGMA user_version = 1;");
}

let FIRST_RUN = db.query("SELECT * FROM users").get() === null || false;

interface IUser {
  id: number;
  email: string;
  password: string;
}

interface IFileNames {
  id: number;
  job_id: number;
  file_name: string;
  output_file_name: string;
  status: string;
}

interface IJobs {
  finished_files: number;
  id: number;
  user_id: number;
  date_created: string;
  status: string;
  num_files: number;
}

// enable WAL mode
db.exec("PRAGMA journal_mode = WAL;");

const app = new Elysia()
  .use(cookie())
  .use(html())
  .use(
    jwt({
      name: "jwt",
      schema: t.Object({
        id: t.String(),
      }),
      secret: process.env.JWT_SECRET || randomUUID(),
      exp: "7d",
    }),
  )
  .use(
    staticPlugin({
      assets: "src/public/",
      prefix: "/",
    }),
  )
  .get("/setup", ({ redirect }) => {
    if (!FIRST_RUN) {
      return redirect("/login");
    }

    return (
      <BaseHtml title="ConvertX | Setup">
        <main class="container">
          <h1>Welcome to ConvertX</h1>
          <article>
            <header>Create your account</header>
            <form method="post" action="/register">
              <fieldset>
                <label>
                  Email/Username
                  <input
                    type="email"
                    name="email"
                    placeholder="Email"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    name="password"
                    placeholder="Password"
                    required
                  />
                </label>
              </fieldset>
              <input type="submit" value="Create account" />
            </form>
            <footer>
              Report any issues on{" "}
              <a href="https://github.com/C4illin/ConvertX">GitHub</a>.
            </footer>
          </article>
        </main>
      </BaseHtml>
    );
  })
  .get("/register", ({ redirect }) => {
    if (!ACCOUNT_REGISTRATION) {
      return redirect("/login");
    }

    return (
      <BaseHtml title="ConvertX | Register">
        <Header />
        <main class="container">
          <article>
            <form method="post">
              <fieldset>
                <label>
                  Email
                  <input
                    type="email"
                    name="email"
                    placeholder="Email"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    name="password"
                    placeholder="Password"
                    required
                  />
                </label>
              </fieldset>
              <input type="submit" value="Register" />
            </form>
          </article>
        </main>
      </BaseHtml>
    );
  })
  .post(
    "/register",
    async ({ body, set, redirect, jwt, cookie: { auth } }) => {
      if (!ACCOUNT_REGISTRATION && !FIRST_RUN) {
        return redirect("/login");
      }

      if (FIRST_RUN) {
        FIRST_RUN = false;
      }

      const existingUser = await db
        .query("SELECT * FROM users WHERE email = ?")
        .get(body.email);
      if (existingUser) {
        set.status = 400;
        return {
          message: "Email already in use.",
        };
      }
      const savedPassword = await Bun.password.hash(body.password);

      db.query("INSERT INTO users (email, password) VALUES (?, ?)").run(
        body.email,
        savedPassword,
      );

      const user = (await db
        .query("SELECT * FROM users WHERE email = ?")
        .get(body.email)) as IUser;

      const accessToken = await jwt.sign({
        id: String(user.id),
      });

      if (!auth) {
        set.status = 500;
        return {
          message: "No auth cookie, perhaps your browser is blocking cookies.",
        };
      }

      // set cookie
      auth.set({
        value: accessToken,
        httpOnly: true,
        secure: true,
        maxAge: 60 * 60 * 24 * 7,
        sameSite: "strict",
      });

      return redirect("/");
    },
    { body: t.Object({ email: t.String(), password: t.String() }) },
  )
  .get("/login", async ({ jwt, redirect, cookie: { auth } }) => {
    if (FIRST_RUN) {
      return redirect("/setup");
    }

    // if already logged in, redirect to home
    if (auth?.value) {
      const user = await jwt.verify(auth.value);

      if (user) {
        return redirect("/");
      }

      auth.remove();
    }

    return (
      <BaseHtml title="ConvertX | Login">
        <Header />
        <main class="container">
          <article>
            <form method="post">
              <fieldset>
                <label>
                  Email
                  <input
                    type="email"
                    name="email"
                    placeholder="Email"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    name="password"
                    placeholder="Password"
                    required
                  />
                </label>
              </fieldset>
              <div role="group">
                {ACCOUNT_REGISTRATION && (
                  <a href="/register" role="button" class="secondary">
                    Register an account
                  </a>
                )}
                <input type="submit" value="Login" />
              </div>
            </form>
          </article>
        </main>
      </BaseHtml>
    );
  })
  .post(
    "/login",
    async function handler({ body, set, redirect, jwt, cookie: { auth } }) {
      const existingUser = (await db
        .query("SELECT * FROM users WHERE email = ?")
        .get(body.email)) as IUser;

      if (!existingUser) {
        set.status = 403;
        return {
          message: "Invalid credentials.",
        };
      }

      const validPassword = await Bun.password.verify(
        body.password,
        existingUser.password,
      );

      if (!validPassword) {
        set.status = 403;
        return {
          message: "Invalid credentials.",
        };
      }

      const accessToken = await jwt.sign({
        id: String(existingUser.id),
      });

      if (!auth) {
        set.status = 500;
        return {
          message: "No auth cookie, perhaps your browser is blocking cookies.",
        };
      }

      // set cookie
      auth.set({
        value: accessToken,
        httpOnly: true,
        secure: true,
        maxAge: 60 * 60 * 24 * 7,
        sameSite: "strict",
      });

      return redirect("/");
    },
    { body: t.Object({ email: t.String(), password: t.String() }) },
  )
  .get("/logoff", ({ redirect, cookie: { auth } }) => {
    if (auth?.value) {
      auth.remove();
    }

    return redirect("/login");
  })
  .post("/logoff", ({ redirect, cookie: { auth } }) => {
    if (auth?.value) {
      auth.remove();
    }

    return redirect("/login");
  })
  .get("/", async ({ jwt, redirect, cookie: { auth, jobId } }) => {
    if (FIRST_RUN) {
      return redirect("/setup");
    }

    if (!auth?.value) {
      return redirect("/login");
    }
    // validate jwt
    const user = await jwt.verify(auth.value);
    if (!user) {
      return redirect("/login");
    }

    // make sure user exists in db
    const existingUser = (await db
      .query("SELECT * FROM users WHERE id = ?")
      .get(user.id)) as IUser;

    if (!existingUser) {
      if (auth?.value) {
        auth.remove();
      }
      return redirect("/login");
    }

    // create a new job
    db.query("INSERT INTO jobs (user_id, date_created) VALUES (?, ?)").run(
      user.id,
      new Date().toISOString(),
    );

    const id = (
      db
        .query("SELECT id FROM jobs WHERE user_id = ? ORDER BY id DESC")
        .get(user.id) as { id: number }
    ).id;

    if (!jobId) {
      return { message: "Cookies should be enabled to use this app." };
    }

    jobId.set({
      value: id,
      httpOnly: true,
      secure: true,
      maxAge: 24 * 60 * 60,
      sameSite: "strict",
    });

    console.log("jobId set to:", id);

    return (
      <BaseHtml>
        <Header loggedIn />
        <main class="container">
          <article>
            <h1>Convert</h1>
            <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
              <table id="file-list" class="striped" />
            </div>
            <input type="file" name="file" multiple />
            {/* <label for="convert_from">Convert from</label> */}
            {/* <select name="convert_from" aria-label="Convert from" required>
              <option selected disabled value="">
                Convert from
              </option>
              {getPossibleInputs().map((input) => (
                // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                <option>{input}</option>
              ))}
            </select> */}
          </article>
          <form method="post" action="/convert">
            <input type="hidden" name="file_names" id="file_names" />
            <article>
              <select name="convert_to" aria-label="Convert to" required>
                <option selected disabled value="">
                  Convert to
                </option>
                {Object.entries(getAllTargets()).map(([converter, targets]) => (
                  // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                  <optgroup label={converter}>
                    {targets.map((target) => (
                      // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                      <option value={`${target},${converter}`}>{target}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </article>
            <input type="submit" value="Convert" />
          </form>
        </main>
        <script src="script.js" defer />
      </BaseHtml>
    );
  })
  .post(
    "/conversions",
    ({ body }) => {
      return (
        <select name="convert_to" aria-label="Convert to" required>
          <option selected disabled value="">
            Convert to
          </option>
          {Object.entries(getPossibleTargets(body.fileType)).map(
            ([converter, targets]) => (
              // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
              <optgroup label={converter}>
                {targets.map((target) => (
                  // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                  <option value={`${target},${converter}`}>{target}</option>
                ))}
              </optgroup>
            ),
          )}
        </select>
      );
    },
    { body: t.Object({ fileType: t.String() }) },
  )
  .post(
    "/upload",
    async ({ body, redirect, jwt, cookie: { auth, jobId } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      if (!jobId?.value) {
        return redirect("/");
      }

      const existingJob = await db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .get(jobId.value, user.id);

      if (!existingJob) {
        return redirect("/");
      }

      const userUploadsDir = `${uploadsDir}${user.id}/${jobId.value}/`;

      if (body?.file) {
        if (Array.isArray(body.file)) {
          for (const file of body.file) {
            await Bun.write(`${userUploadsDir}${file.name}`, file);
          }
        } else {
          await Bun.write(
            `${userUploadsDir}${
              // biome-ignore lint/complexity/useLiteralKeys: ts bug
              body.file["name"]
            }`,
            body.file,
          );
        }
      }

      return {
        message: "Files uploaded successfully.",
      };
    },
    { body: t.Object({ file: t.Files() }) },
  )
  .post(
    "/delete",
    async ({ body, redirect, jwt, cookie: { auth, jobId } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      if (!jobId?.value) {
        return redirect("/");
      }

      const existingJob = await db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .get(jobId.value, user.id);

      if (!existingJob) {
        return redirect("/");
      }

      const userUploadsDir = `${uploadsDir}${user.id}/${jobId.value}/`;

      await unlink(`${userUploadsDir}${body.filename}`);
    },
    { body: t.Object({ filename: t.String() }) },
  )
  .post(
    "/convert",
    async ({ body, redirect, jwt, cookie: { auth, jobId } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      if (!jobId?.value) {
        return redirect("/");
      }

      const existingJob = (await db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .get(jobId.value, user.id)) as IJobs;

      if (!existingJob) {
        return redirect("/");
      }

      const userUploadsDir = `${uploadsDir}${user.id}/${jobId.value}/`;
      const userOutputDir = `${outputDir}${user.id}/${jobId.value}/`;

      // create the output directory
      try {
        await mkdir(userOutputDir, { recursive: true });
      } catch (error) {
        console.error(
          `Failed to create the output directory: ${userOutputDir}.`,
          error,
        );
      }

      const convertTo = normalizeFiletype(
        body.convert_to.split(",")[0] as string,
      );
      const converterName = body.convert_to.split(",")[1];
      const fileNames = JSON.parse(body.file_names) as string[];

      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return redirect("/");
      }

      db.run(
        "UPDATE jobs SET num_files = ?, status = 'pending' WHERE id = ?",
        fileNames.length,
        jobId.value,
      );

      const query = db.query(
        "INSERT INTO file_names (job_id, file_name, output_file_name, status) VALUES (?, ?, ?, ?)",
      );

      // Start the conversion process in the background
      Promise.all(
        fileNames.map(async (fileName) => {
          const filePath = `${userUploadsDir}${fileName}`;
          const fileTypeOrig = fileName.split(".").pop() as string;
          const fileType = normalizeFiletype(fileTypeOrig);
          const newFileExt = normalizeOutputFiletype(convertTo);
          const newFileName = fileName.replace(fileTypeOrig, newFileExt);
          const targetPath = `${userOutputDir}${newFileName}`;

          const result = await mainConverter(
            filePath,
            fileType,
            convertTo,
            targetPath,
            {},
            converterName,
          );

          query.run(jobId.value, fileName, newFileName, result);
        }),
      )
        .then(() => {
          // All conversions are done, update the job status to 'completed'
          db.run(
            "UPDATE jobs SET status = 'completed' WHERE id = ?",
            jobId.value,
          );

          // delete all uploaded files in userUploadsDir
          // rmSync(userUploadsDir, { recursive: true, force: true });
        })
        .catch((error) => {
          console.error("Error in conversion process:", error);
        });

      // Redirect the client immediately
      return redirect(`/results/${jobId.value}`);
    },
    {
      body: t.Object({
        convert_to: t.String(),
        file_names: t.String(),
      }),
    },
  )
  .get("/history", async ({ jwt, redirect, cookie: { auth } }) => {
    if (!auth?.value) {
      return redirect("/login");
    }
    const user = await jwt.verify(auth.value);

    if (!user) {
      return redirect("/login");
    }

    let userJobs = db
      .query("SELECT * FROM jobs WHERE user_id = ?")
      .all(user.id) as IJobs[];

    for (const job of userJobs) {
      const files = db
        .query("SELECT * FROM file_names WHERE job_id = ?")
        .all(job.id) as IFileNames[];

      job.finished_files = files.length;
    }

    // filter out jobs with no files
    userJobs = userJobs.filter((job) => job.num_files > 0);

    return (
      <BaseHtml title="ConvertX | Results">
        <Header loggedIn />
        <main class="container">
          <article>
            <h1>Results</h1>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Files</th>
                  <th>Files Done</th>
                  <th>Status</th>
                  <th>View</th>
                </tr>
              </thead>
              <tbody>
                {userJobs.map((job) => (
                  // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                  <tr>
                    <td>{job.date_created}</td>
                    <td>{job.num_files}</td>
                    <td>{job.finished_files}</td>
                    <td>{job.status}</td>
                    <td>
                      <a href={`/results/${job.id}`}>View</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        </main>
      </BaseHtml>
    );
  })
  .get(
    "/results/:jobId",
    async ({ params, jwt, set, redirect, cookie: { auth, job_id } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      if (job_id?.value) {
        // clear the job_id cookie since we are viewing the results
        job_id.remove();
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      const job = (await db
        .query("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
        .get(user.id, params.jobId)) as IJobs;

      if (!job) {
        set.status = 404;
        return {
          message: "Job not found.",
        };
      }

      const outputPath = `${user.id}/${params.jobId}/`;

      const files = db
        .query("SELECT * FROM file_names WHERE job_id = ?")
        .all(params.jobId) as IFileNames[];

      return (
        <BaseHtml title="ConvertX | Result">
          <Header loggedIn />
          <main class="container">
            <article>
              <div class="grid">
                <h1>Results</h1>
                <div>
                  <button
                    type="button"
                    style={{ width: "10rem", float: "right" }}
                    onclick="downloadAll()"
                    {...(files.length !== job.num_files && { disabled: true })}>
                    Download All
                  </button>
                </div>
              </div>
              <progress max={job.num_files} value={files.length} />
              <table>
                <thead>
                  <tr>
                    <th>Converted File Name</th>
                    <th>Status</th>
                    <th>View</th>
                    <th>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                    <tr>
                      <td>{file.output_file_name}</td>
                      <td>{file.status}</td>
                      <td>
                        <a
                          href={`/download/${outputPath}${file.output_file_name}`}>
                          View
                        </a>
                      </td>
                      <td>
                        <a
                          href={`/download/${outputPath}${file.output_file_name}`}
                          download={file.output_file_name}>
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          </main>
          <script src="/results.js" defer />
        </BaseHtml>
      );
    },
  )
  .get(
    "/progress/:jobId",
    async ({ jwt, set, params, redirect, cookie: { auth, job_id } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      if (job_id?.value) {
        // clear the job_id cookie since we are viewing the results
        job_id.remove();
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      const job = (await db
        .query("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
        .get(user.id, params.jobId)) as IJobs;

      if (!job) {
        set.status = 404;
        return {
          message: "Job not found.",
        };
      }

      const outputPath = `${user.id}/${params.jobId}/`;

      const files = db
        .query("SELECT * FROM file_names WHERE job_id = ?")
        .all(params.jobId) as IFileNames[];

      return (
        <article>
          <div class="grid">
            <h1>Results</h1>
            <div>
              <button
                type="button"
                style={{ width: "10rem", float: "right" }}
                onclick="downloadAll()"
                {...(files.length !== job.num_files && { disabled: true })}>
                Download All
              </button>
            </div>
          </div>
          <progress max={job.num_files} value={files.length} />
          <table>
            <thead>
              <tr>
                <th>Converted File Name</th>
                <th>View</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                <tr>
                  <td>{file.output_file_name}</td>
                  <td>
                    <a href={`/download/${outputPath}${file.output_file_name}`}>
                      View
                    </a>
                  </td>
                  <td>
                    <a
                      href={`/download/${outputPath}${file.output_file_name}`}
                      download={file.output_file_name}>
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      );
    },
  )
  .get(
    "/download/:userId/:jobId/:fileName",
    async ({ params, jwt, redirect, cookie: { auth } }) => {
      if (!auth?.value) {
        return redirect("/login");
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      const job = await db
        .query("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
        .get(user.id, params.jobId);

      if (!job) {
        return redirect("/results");
      }
      // parse from url encoded string
      const userId = decodeURIComponent(params.userId);
      const jobId = decodeURIComponent(params.jobId);
      const fileName = decodeURIComponent(params.fileName);

      const filePath = `${outputDir}${userId}/${jobId}/${fileName}`;
      return Bun.file(filePath);
    },
  )
  .get("/converters", async ({ jwt, redirect, cookie: { auth } }) => {
    if (!auth?.value) {
      return redirect("/login");
    }

    const user = await jwt.verify(auth.value);
    if (!user) {
      return redirect("/login");
    }

    return (
      <BaseHtml title="ConvertX | Converters">
        <Header loggedIn />
        <main class="container">
          <article>
            <h1>Converters</h1>
            <table>
              <thead>
                <tr>
                  <th>Converter</th>
                  <th>From (Count)</th>
                  <th>To (Count)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(getAllTargets()).map(([converter, targets]) => {
                  const inputs = getAllInputs(converter);
                  return (
                    // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                    <tr>
                      <td>{converter}</td>
                      <td>
                        Count: {inputs.length}
                        <ul>
                          {inputs.map((input) => (
                            // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                            <li>{input}</li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        Count: {targets.length}
                        <ul>
                          {targets.map((target) => (
                            // biome-ignore lint/correctness/useJsxKeyInIterable: <explanation>
                            <li>{target}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </article>
        </main>
      </BaseHtml>
    );
  })
  .get(
    "/zip/:userId/:jobId",
    async ({ params, jwt, redirect, cookie: { auth } }) => {
      // TODO: Implement zip download
      if (!auth?.value) {
        return redirect("/login");
      }

      const user = await jwt.verify(auth.value);
      if (!user) {
        return redirect("/login");
      }

      const job = await db
        .query("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
        .get(user.id, params.jobId);

      if (!job) {
        return redirect("/results");
      }

      const userId = decodeURIComponent(params.userId);
      const jobId = decodeURIComponent(params.jobId);
      const outputPath = `${outputDir}${userId}/${jobId}/`;

      // return Bun.zip(outputPath);
    },
  )
  .onError(({ code, error, request }) => {
    // log.error(` ${request.method} ${request.url}`, code, error);
    console.error(error);
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`,
);

const clearJobs = () => {
  // clear all jobs older than 24 hours
  // get all files older than 24 hours
  const jobs = db
    .query("SELECT * FROM jobs WHERE date_created < ?")
    .all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) as IJobs[];

  for (const job of jobs) {
    // delete the directories
    rmSync(`${outputDir}${job.user_id}/${job.id}`, { recursive: true });
    rmSync(`${uploadsDir}${job.user_id}/${job.id}`, { recursive: true });

    // delete the job
    db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
  }

  // run every 24 hours
  setTimeout(clearJobs, 24 * 60 * 60 * 1000);
};
clearJobs();

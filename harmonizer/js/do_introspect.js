/**
 * This `bridge` is defined as a global by the runtime we define in Rust.
 * We declare this as a `var` here only to allow the TSDoc type annotation to be
 * applied to it. Running `var` multiple times has no effect.
 * @type {{
 *   introspect: import('../../federation-js').introspection,
 * }} */
var bridge;

/**
 * @type {string}
 */
var sdl = sdl;

if (!sdl) {
  throw new Error("Error in JS-Rust-land: sdl is empty.");
}

getMethods = (obj) => Object.getOwnPropertyNames(obj).filter(item => typeof obj[item] === 'function')



try {

  /**
   * @type {{ errors: Error[], introspectionQueryResult?: undefined } | { errors?: undefined, introspectionQueryResult: string }}
   */
  const introspected = bridge.introspect(sdl);

  done(
    introspected.errors ? { Err: introspected.errors } : { Ok: introspected.introspectionQueryResult },
  );
} catch (err) {
  done({ Err: [err] });
}

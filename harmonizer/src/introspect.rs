/*!
# Compose graphql schemas
*/

use crate::js::Js;
use serde::{Deserialize, Serialize};
use std::fmt::Display;
use thiserror::Error;

/// An error which occurred during JavaScript introspection.
///
/// The shape of this error is meant to mimick that of the error created within
/// JavaScript, which is a [`GraphQLError`] from the [`graphql-js`] library.
///
/// [`graphql-js']: https://npm.im/graphql
/// [`GraphQLError`]: https://github.com/graphql/graphql-js/blob/3869211/src/error/GraphQLError.js#L18-L75
#[derive(Debug, Error, Serialize, Deserialize, PartialEq)]
pub struct IntrospectionError {
    /// A human-readable description of the error that prevented introspection.
    pub message: Option<String>,
    /// [`CompositionErrorExtensions`]
    pub extensions: Option<IntrospectionErrorExtensions>,
}

impl Display for IntrospectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(msg) = &self.message {
            f.write_fmt(format_args!("{code}: {msg}", code = self.code(), msg = msg))
        } else {
            f.write_str(self.code())
        }
    }
}

/// Mimicking the JavaScript-world from which this error comes, this represents
/// the `extensions` property of a JavaScript [`GraphQLError`] from the
/// [`graphql-js`] library. Such errors are created when errors have prevented
/// successful composition, which is accomplished using [`errorWithCode`]. An
/// [example] of this can be seen within the `federation-js` JavaScript library.
///
/// [`graphql-js']: https://npm.im/graphql
/// [`GraphQLError`]: https://github.com/graphql/graphql-js/blob/3869211/src/error/GraphQLError.js#L18-L75
/// [`errorWithCode`]: https://github.com/apollographql/federation/blob/d7ca0bc2/federation-js/src/composition/utils.ts#L200-L216
/// [example]: https://github.com/apollographql/federation/blob/d7ca0bc2/federation-js/src/composition/validate/postComposition/executableDirectivesInAllServices.ts#L47-L53
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct IntrospectionErrorExtensions {
    /// An Apollo Federation composition error code.
    ///
    /// A non-exhaustive list of error codes that this includes, is:
    ///
    ///   - EXTERNAL_TYPE_MISMATCH
    ///   - EXTERNAL_UNUSED
    ///   - KEY_FIELDS_MISSING_ON_BASE
    ///   - KEY_MISSING_ON_BASE
    ///   - KEY_NOT_SPECIFIED
    ///   - PROVIDES_FIELDS_MISSING_EXTERNAL
    ///
    /// ...and many more!  See the `federation-js` composition library for
    /// more details (and search for `errorWithCode`).
    pub code: String,
}

/// An error that was received during composition within JavaScript.
impl IntrospectionError {
    /// Retrieve the error code from an error received during composition.
    pub fn code(&self) -> &str {
        match self.extensions {
            Some(ref ext) => &*ext.code,
            None => "UNKNOWN",
        }
    }
}

/// The `introspect` function receives a [`string`] representing the SDL and invokes JavaScript
/// introspection on it.
///
pub fn introspect(sdl: String) -> Result<String, Vec<IntrospectionError>> {
    Js::new()
        .with_parameter("sdl", sdl)
        .execute("do_introspect", include_str!("../js/do_introspect.js"))
}

#[cfg(test)]
mod tests {
    use crate::introspect::introspect;
    #[test]
    fn it_works() {
        let raw_sdl = r#"schema
        {
          query: Query
        }
  
        type Query {
          hello: String
        }
        "#;

        introspect(raw_sdl.to_string()).unwrap();
        insta::assert_snapshot!(introspect(raw_sdl.to_string()).unwrap());
    }

    #[test]
    fn invalid_sdl() {
        use crate::introspect::IntrospectionError;
        let expected_error = vec![IntrospectionError {
            message: Some(r#"couldn't build schema from sdl: Error: Unknown type "Query".. Unknown type "Query"."#.to_string()),
            extensions: None,
        }];
        assert_eq!(
            expected_error,
            introspect(
                "schema {
                    query: Query
                }"
                .to_string()
            )
            .unwrap_err()
        );
    }
}

import { useEffect, useState } from "react";

import { getAppVersion } from "../lib/api";


/** Quiet runtime-build identity for the expanded sidebar footer. */
export function AppVersion() {
  const [version, setVersion] = useState<string | null>();

  useEffect(() => {
    let cancelled = false;
    void getAppVersion()
      .then((value) => {
        if (!cancelled) setVersion(value === "unknown" ? null : value);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = version === undefined
    ? "Version ..."
    : version === null
      ? "Version unavailable"
      : `Version v${version}`;

  return <div className="app-version">{label}</div>;
}

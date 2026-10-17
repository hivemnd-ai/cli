// JXA imports Security functions but not its CFString constants. These are the
// corresponding stable SecItem keys from Apple's Security/SecItemConstants.c.
// Only public operation/account metadata is passed in argv; data uses stdin.
export const macOsKeychainScript = `
function run(args) {
  ObjC.import("Foundation");
  ObjC.import("Security");
  const query = { class: "genp", acct: args[1], svce: "hivemnd-cli" };
  if (args[0] === "get") {
    query.r_Data = true;
    const result = Ref();
    const status = $.SecItemCopyMatching($(query), result);
    if (status === -25300) return "";
    if (status !== 0) throw Error("Keychain read failed");
    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(result[0]), $.NSUTF8StringEncoding));
  }
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (Number(data.length) === 0) throw Error("Credential input is empty");
  const update = $({ v_Data: data });
  let status = $.SecItemUpdate($(query), update);
  if (status === -25300) {
    query.v_Data = data;
    status = $.SecItemAdd($(query), null);
  }
  if (status !== 0) throw Error("Keychain save failed");
  return "";
}
`;

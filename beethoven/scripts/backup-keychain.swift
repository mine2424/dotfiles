import Foundation
import Security
let args=Array(CommandLine.arguments.dropFirst())
let operation=args.first ?? "status"
let account=args.count>1 ? args[1] : "primary"
guard account == "primary" || account.range(of:"^recovery-code-[a-f0-9]{64}$",options:.regularExpression) != nil else {exit(2)}
// The local login keychain needs no iCloud entitlement. Never request broad ACL access.
let base:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"local.beethoven.backup.v1",kSecAttrAccount as String:account]
func fail(_ status:OSStatus)->Never{FileHandle.standardError.write(Data("keychain_status:\(status)\n".utf8));exit(1)}
if operation == "save" {
 let data=FileHandle.standardInput.readDataToEndOfFile()
 guard (account == "primary" ? (1024...16384).contains(data.count):(32...128).contains(data.count)) else {fail(errSecParam)}
 var query=base;query[kSecValueData as String]=data;query[kSecAttrLabel as String]="Beethoven backup: "+account
 let status=SecItemAdd(query as CFDictionary,nil);guard status==errSecSuccess else{fail(status)}
 print("stored")
} else if operation == "read" || operation == "status" {
 var query=base;query[kSecMatchLimit as String]=kSecMatchLimitOne
 if operation == "read"{query[kSecReturnData as String]=true}
 var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
 if operation == "status" && status == errSecItemNotFound{print("missing");exit(0)}
 guard status==errSecSuccess else{fail(status)}
 if operation == "read"{guard let data=result as? Data else{fail(errSecDecode)};FileHandle.standardOutput.write(data)}else{print("present")}
} else {fail(errSecParam)}

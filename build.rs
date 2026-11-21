fn main() {
    println!("cargo:rerun-if-changed=assets/Aethrix.ico");
    winresource::WindowsResource::new()
        .set_icon_with_id("assets/Aethrix.ico", "1")
        .set("ProductName", "Aethrix")
        .set("FileDescription", "Aethrix video editor")
        .set("OriginalFilename", "Aethrix.exe")
        .compile()
        .expect("embed the Aethrix Windows icon");
}

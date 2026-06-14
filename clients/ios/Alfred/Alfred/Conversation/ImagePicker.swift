//
//  ImagePicker.swift
//  Alfred
//
//  A PhotosPicker that loads the chosen photo, re-encodes it as JPEG (0.85 quality),
//  and hands the bytes to the caller. The caller uploads them via AlfredClient.upload
//  and appends the returned Attachment to the composer's pending list.
//
//  PhotosPicker reads from the user's library through the system picker UI, so it needs
//  no photo-library permission and no Info.plist usage string.
//

import PhotosUI
import SwiftUI

struct ImagePicker: View {
    /// Called with JPEG bytes once a photo has been picked and decoded.
    let onPicked: (Data) -> Void

    @State private var selection: PhotosPickerItem?
    @State private var loading = false

    var body: some View {
        PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
            if loading {
                ProgressView()
            } else {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
        }
        .onChange(of: selection) { _, newItem in
            guard let newItem else { return }
            loading = true
            Task {
                let jpeg = await Self.jpegData(from: newItem)
                await MainActor.run {
                    loading = false
                    selection = nil
                    if let jpeg {
                        onPicked(jpeg)
                    }
                }
            }
        }
    }

    /// Load the picked item as an image and re-encode it as JPEG. Returns nil on any
    /// failure (unreadable item, undecodable image) so the caller can ignore it quietly.
    nonisolated private static func jpegData(from item: PhotosPickerItem) async -> Data? {
        guard
            let data = try? await item.loadTransferable(type: Data.self),
            let image = UIImage(data: data)
        else {
            return nil
        }
        return image.jpegData(compressionQuality: 0.85)
    }
}
